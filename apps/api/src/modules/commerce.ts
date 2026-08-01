import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  cartItemMutationSchema,
  cartItemRemovalSchema,
  quoteCreateSchema,
  uuidSchema,
  type CartItemMutation,
  type CartSummary,
  type ErrorEnvelope,
  type QuoteCreate,
  type QuoteSummary,
  type ResponseMeta,
  type SessionContext,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  Money,
  assertCartMutationContext,
  calculateCartLine,
  calculateQuoteExpiry,
} from '@alo-noon/domain'

import { authenticateRequest, type AuthDependencies } from './auth.js'

const cartInclude = {
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      bakeryProductOffering: {
        include: {
          bakeryBranch: { include: { city: true } },
          productVariant: { include: { product: true } },
        },
      },
    },
  },
} satisfies Prisma.CartInclude

const quoteInclude = {
  items: { orderBy: { id: 'asc' } },
} satisfies Prisma.QuoteInclude

type CartRecord = Prisma.CartGetPayload<{ include: typeof cartInclude }>
type QuoteRecord = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>
type OfferingRecord = Prisma.BakeryProductOfferingGetPayload<{
  include: {
    bakeryBranch: { include: { city: true } }
    productVariant: { include: { product: true } }
  }
}>

export interface CommerceRepository {
  getCart(tenantId: string, customerId: string): Promise<CartSummary | null>
  upsertItem(
    tenantId: string,
    customerId: string,
    offeringId: string,
    input: CartItemMutation,
    now: Date,
    correlationId: string,
  ): Promise<CartSummary>
  removeItem(
    tenantId: string,
    customerId: string,
    offeringId: string,
    expectedVersion: number | undefined,
    now: Date,
    correlationId: string,
  ): Promise<CartSummary>
  createQuote(
    tenantId: string,
    customerId: string,
    input: QuoteCreate,
    now: Date,
    correlationId: string,
  ): Promise<QuoteSummary>
}

export interface CommerceDependencies {
  repository: CommerceRepository
  auth: AuthDependencies
  now?: () => Date
}

export class CommerceError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

export function registerCommerceRoutes(
  app: FastifyInstance,
  dependencies: CommerceDependencies,
): void {
  app.get('/api/v1/cart', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticatedCustomer(request, dependencies.auth)
    if (!session) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }

    try {
      return {
        success: true,
        data: await dependencies.repository.getCart(session.tenantId, session.customerId),
        meta: responseMeta(),
      }
    } catch (error) {
      return commerceFailure(request, reply, error)
    }
  })

  app.put('/api/v1/cart/items/:offeringId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticatedCustomer(request, dependencies.auth)
    if (!session) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    const offeringId = pathOfferingId(request.params)
    const parsed = cartItemMutationSchema.safeParse(request.body)
    if (!offeringId || !parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_CART_MUTATION', 'Cart mutation is invalid.'))
    }

    try {
      return {
        success: true,
        data: await dependencies.repository.upsertItem(
          session.tenantId,
          session.customerId,
          offeringId,
          parsed.data,
          currentTime(dependencies),
          randomUUID(),
        ),
        meta: responseMeta(),
      }
    } catch (error) {
      return commerceFailure(request, reply, error)
    }
  })

  app.delete('/api/v1/cart/items/:offeringId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticatedCustomer(request, dependencies.auth)
    if (!session) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    const offeringId = pathOfferingId(request.params)
    const parsed = cartItemRemovalSchema.safeParse(request.body ?? {})
    if (!offeringId || !parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_CART_MUTATION', 'Cart mutation is invalid.'))
    }

    try {
      return {
        success: true,
        data: await dependencies.repository.removeItem(
          session.tenantId,
          session.customerId,
          offeringId,
          parsed.data.expectedCartVersion,
          currentTime(dependencies),
          randomUUID(),
        ),
        meta: responseMeta(),
      }
    } catch (error) {
      return commerceFailure(request, reply, error)
    }
  })

  app.post('/api/v1/cart/quote', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const session = await authenticatedCustomer(request, dependencies.auth)
    if (!session) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    const parsed = quoteCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_QUOTE_REQUEST', 'Quote request is invalid.'))
    }

    try {
      return reply.code(201).send({
        success: true,
        data: await dependencies.repository.createQuote(
          session.tenantId,
          session.customerId,
          parsed.data,
          currentTime(dependencies),
          randomUUID(),
        ),
        meta: responseMeta(),
      })
    } catch (error) {
      return commerceFailure(request, reply, error)
    }
  })
}

export function createPrismaCommerceRepository(prisma: PrismaClient): CommerceRepository {
  return {
    async getCart(tenantId, customerId) {
      const cart = await prisma.cart.findFirst({
        where: { tenantId, customerId, state: 'ACTIVE' },
        include: cartInclude,
      })
      return cart ? mapCart(cart) : null
    },

    async upsertItem(tenantId, customerId, offeringId, input, now, correlationId) {
      return serializable(prisma, async (transaction) => {
        const offering = await loadOffering(transaction, tenantId, offeringId)
        assertOfferingAvailable(offering, now)
        assertOfferingQuantityCapacity(offering, input.quantity)
        assertRequestedContext(offering, input.cityId, input.operationalZoneId)
        await assertBranchCapacity(transaction, offering, now)

        let cart = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          select: {
            id: true,
            cityId: true,
            operationalZoneId: true,
            bakeryBranchId: true,
            version: true,
          },
        })

        if (!cart) {
          if (input.expectedCartVersion !== undefined) {
            throw new CommerceError('CART_VERSION_CONFLICT', 409)
          }
          cart = await transaction.cart.create({
            data: {
              tenantId,
              customerId,
              cityId: input.cityId,
              operationalZoneId: input.operationalZoneId,
              bakeryBranchId: offering.bakeryBranchId,
            },
            select: {
              id: true,
              cityId: true,
              operationalZoneId: true,
              bakeryBranchId: true,
              version: true,
            },
          })
        } else {
          assertCartMutationContext({
            ...cart,
            ...(input.expectedCartVersion !== undefined && {
              expectedVersion: input.expectedCartVersion,
            }),
            offeringCityId: offering.bakeryBranch.cityId,
            offeringOperationalZoneId: offering.bakeryBranch.operationalZoneId,
            offeringBakeryBranchId: offering.bakeryBranchId,
          })
          const updated = await transaction.cart.updateMany({
            where: { id: cart.id, state: 'ACTIVE', version: cart.version },
            data: { version: { increment: 1 } },
          })
          if (updated.count !== 1) throw new CommerceError('CART_VERSION_CONFLICT', 409)
        }

        await transaction.cartItem.upsert({
          where: {
            cartId_bakeryProductOfferingId: {
              cartId: cart.id,
              bakeryProductOfferingId: offeringId,
            },
          },
          create: {
            tenantId,
            cartId: cart.id,
            bakeryProductOfferingId: offeringId,
            quantity: input.quantity,
          },
          update: { quantity: input.quantity },
        })
        await invalidateQuotes(transaction, cart.id, now)
        await recordCommerceChange(
          transaction,
          tenantId,
          customerId,
          cart.id,
          'cart.item_upserted',
          correlationId,
          now,
          { offeringId, quantity: input.quantity },
        )
        return loadCart(transaction, cart.id)
      })
    },

    async removeItem(tenantId, customerId, offeringId, expectedVersion, now, correlationId) {
      return serializable(prisma, async (transaction) => {
        const cart = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          select: {
            id: true,
            cityId: true,
            operationalZoneId: true,
            bakeryBranchId: true,
            version: true,
          },
        })
        if (!cart) throw new CommerceError('CART_NOT_FOUND', 404)
        if (expectedVersion !== undefined && expectedVersion !== cart.version) {
          throw new CommerceError('CART_VERSION_CONFLICT', 409)
        }
        const removed = await transaction.cartItem.deleteMany({
          where: { cartId: cart.id, bakeryProductOfferingId: offeringId },
        })
        if (removed.count !== 1) throw new CommerceError('CART_ITEM_NOT_FOUND', 404)
        const updated = await transaction.cart.updateMany({
          where: { id: cart.id, state: 'ACTIVE', version: cart.version },
          data: { version: { increment: 1 } },
        })
        if (updated.count !== 1) throw new CommerceError('CART_VERSION_CONFLICT', 409)
        await invalidateQuotes(transaction, cart.id, now)
        await recordCommerceChange(
          transaction,
          tenantId,
          customerId,
          cart.id,
          'cart.item_removed',
          correlationId,
          now,
          { offeringId },
        )
        return loadCart(transaction, cart.id)
      })
    },

    async createQuote(tenantId, customerId, input, now, correlationId) {
      return serializable(prisma, async (transaction) => {
        const replay = await transaction.quote.findUnique({
          where: { idempotencyKey: input.idempotencyKey, tenantId },
          include: quoteInclude,
        })
        if (replay) {
          if (replay.customerId !== customerId) {
            throw new CommerceError('IDEMPOTENCY_KEY_CONFLICT', 409)
          }
          if (replay.status === 'ACTIVE' && replay.expiresAt <= now) {
            return mapQuote(
              await transaction.quote.update({
                where: { id: replay.id },
                data: { status: 'EXPIRED' },
                include: quoteInclude,
              }),
            )
          }
          return mapQuote(replay)
        }

        const cart = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          include: cartInclude,
        })
        if (!cart) throw new CommerceError('CART_NOT_FOUND', 404)
        if (cart.version !== input.expectedCartVersion) {
          throw new CommerceError('CART_VERSION_CONFLICT', 409)
        }
        if (cart.items.length === 0) throw new CommerceError('CART_EMPTY', 422)

        const quoteItems: Prisma.QuoteItemUncheckedCreateWithoutQuoteInput[] = []
        let subtotal = Money.irr(0)
        for (const item of cart.items) {
          const offering = item.bakeryProductOffering
          assertOfferingAvailable(offering, now)
          assertOfferingQuantityCapacity(offering, item.quantity)
          assertCartMutationContext({
            cityId: cart.cityId,
            operationalZoneId: cart.operationalZoneId,
            bakeryBranchId: cart.bakeryBranchId,
            version: cart.version,
            offeringCityId: offering.bakeryBranch.cityId,
            offeringOperationalZoneId: offering.bakeryBranch.operationalZoneId,
            offeringBakeryBranchId: offering.bakeryBranchId,
          })
          const unitPrice = Money.irr(offering.priceAmount)
          const lineTotal = calculateCartLine(unitPrice, item.quantity)
          subtotal = subtotal.add(lineTotal)
          quoteItems.push({
            tenantId,
            bakeryProductOfferingId: offering.id,
            productVariantId: offering.productVariantId,
            bakeryBranchId: offering.bakeryBranchId,
            skuSnapshot: offering.productVariant.sku,
            nameFaSnapshot: offering.productVariant.nameFa,
            fulfillmentClassSnapshot: offering.productVariant.fulfillmentClass,
            freshnessClaimSnapshot: offering.productVariant.freshnessClaim,
            quantity: item.quantity,
            unitPriceAmount: unitPrice.amount,
            lineTotalAmount: lineTotal.amount,
            currency: 'IRR' as const,
          })
        }
        await assertBranchCapacity(transaction, cart.items[0]!.bakeryProductOffering, now)
        await transaction.quote.updateMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED' },
        })

        const quote = await transaction.quote.create({
          data: {
            tenantId,
            idempotencyKey: input.idempotencyKey,
            cartId: cart.id,
            customerId,
            cartVersion: cart.version,
            expiresAt: calculateQuoteExpiry(now),
            subtotalAmount: subtotal.amount,
            totalAmount: subtotal.amount,
            items: { create: quoteItems },
          },
          include: quoteInclude,
        })
        await recordCommerceChange(
          transaction,
          tenantId,
          customerId,
          quote.id,
          'quote.created',
          correlationId,
          now,
          {
            cartId: cart.id,
            cartVersion: cart.version,
            expiresAt: quote.expiresAt.toISOString(),
          },
        )
        return mapQuote(quote)
      })
    },
  }
}

async function serializable<T>(
  prisma: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(operation, { isolationLevel: 'Serializable' })
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'P2034') {
      throw new CommerceError('CART_VERSION_CONFLICT', 409)
    }
    throw error
  }
}

async function authenticatedCustomer(
  request: Parameters<typeof authenticateRequest>[0],
  auth: AuthDependencies,
): Promise<{ customerId: string; session: SessionContext } | null> {
  const session = await authenticateRequest(request, auth)
  return session?.customerId
    ? { tenantId: session.tenantId, customerId: session.customerId, session }
    : null
}

async function loadOffering(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  offeringId: string,
): Promise<OfferingRecord> {
  const offering = await transaction.bakeryProductOffering.findFirst({
    where: { id: offeringId, tenantId },
    include: {
      bakeryBranch: { include: { city: true } },
      productVariant: { include: { product: true } },
    },
  })
  if (!offering) throw new CommerceError('OFFERING_NOT_FOUND', 404)
  return offering
}

function assertOfferingAvailable(offering: OfferingRecord, now: Date): void {
  if (
    offering.availability !== 'AVAILABLE' ||
    offering.bakeryBranch.operationalStatus !== 'ACTIVE' ||
    offering.bakeryBranch.qualityStatus !== 'APPROVED' ||
    offering.productVariant.lifecycle !== 'ACTIVE' ||
    offering.productVariant.product.lifecycle !== 'ACTIVE' ||
    (offering.availableFrom && offering.availableFrom > now) ||
    (offering.availableUntil && offering.availableUntil <= now) ||
    offering.dailyCapacity === 0
  ) {
    throw new CommerceError('OFFERING_UNAVAILABLE', 422)
  }
}

function assertRequestedContext(
  offering: OfferingRecord,
  cityId: string,
  operationalZoneId: string,
): void {
  if (
    offering.bakeryBranch.cityId !== cityId ||
    offering.bakeryBranch.operationalZoneId !== operationalZoneId
  ) {
    throw new CommerceError('CART_CONTEXT_MISMATCH', 422)
  }
}

function assertOfferingQuantityCapacity(offering: OfferingRecord, quantity: number): void {
  if (offering.dailyCapacity !== null && quantity > offering.dailyCapacity) {
    throw new CommerceError('CAPACITY_UNAVAILABLE', 422)
  }
}

async function assertBranchCapacity(
  transaction: Prisma.TransactionClient,
  offering: OfferingRecord,
  now: Date,
): Promise<void> {
  const serviceDate = serviceDateAt(now, offering.bakeryBranch.city.timezone)
  const slot = await transaction.bakeryCapacitySlot.findUnique({
    where: {
      bakeryBranchId_serviceDate: {
        bakeryBranchId: offering.bakeryBranchId,
        serviceDate,
      },
    },
  })
  if (slot && (slot.suspended || slot.reservedOrders >= slot.maxOrders)) {
    throw new CommerceError('CAPACITY_UNAVAILABLE', 422)
  }
}

function serviceDateAt(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`)
}

async function loadCart(
  transaction: Prisma.TransactionClient,
  cartId: string,
): Promise<CartSummary> {
  const cart = await transaction.cart.findUnique({ where: { id: cartId }, include: cartInclude })
  if (!cart) throw new CommerceError('CART_NOT_FOUND', 404)
  return mapCart(cart)
}

function mapCart(cart: CartRecord): CartSummary {
  let subtotal = Money.irr(0)
  const items: CartSummary['items'] = cart.items.map((item) => {
    const offering = item.bakeryProductOffering
    const unitPrice = Money.irr(offering.priceAmount)
    const lineTotal = calculateCartLine(unitPrice, item.quantity)
    subtotal = subtotal.add(lineTotal)
    return {
      id: item.id,
      bakeryProductOfferingId: offering.id,
      productVariantId: offering.productVariantId,
      bakeryBranchId: offering.bakeryBranchId,
      sku: offering.productVariant.sku,
      nameFa: offering.productVariant.nameFa,
      fulfillmentClass: offering.productVariant.fulfillmentClass,
      freshnessClaim: offering.productVariant.freshnessClaim,
      quantity: item.quantity,
      unitPrice: { amount: unitPrice.amount.toString(), currency: 'IRR' as const },
      lineTotal: { amount: lineTotal.amount.toString(), currency: 'IRR' as const },
    }
  })
  return {
    id: cart.id,
    cityId: cart.cityId,
    operationalZoneId: cart.operationalZoneId,
    bakeryBranchId: cart.bakeryBranchId,
    version: cart.version,
    subtotal: { amount: subtotal.amount.toString(), currency: 'IRR' },
    items,
    updatedAt: cart.updatedAt.toISOString(),
  }
}

function mapQuote(quote: QuoteRecord): QuoteSummary {
  return {
    id: quote.id,
    publicId: quote.publicId,
    cartId: quote.cartId,
    cartVersion: quote.cartVersion,
    status: quote.status,
    expiresAt: quote.expiresAt.toISOString(),
    subtotal: { amount: quote.subtotalAmount.toString(), currency: quote.currency },
    deliveryFee: { amount: quote.deliveryFeeAmount.toString(), currency: quote.currency },
    discount: { amount: quote.discountAmount.toString(), currency: quote.currency },
    total: { amount: quote.totalAmount.toString(), currency: quote.currency },
    items: quote.items.map((item) => ({
      id: item.id,
      bakeryProductOfferingId: item.bakeryProductOfferingId,
      productVariantId: item.productVariantId,
      bakeryBranchId: item.bakeryBranchId,
      sku: item.skuSnapshot,
      nameFa: item.nameFaSnapshot,
      fulfillmentClass: item.fulfillmentClassSnapshot,
      freshnessClaim: item.freshnessClaimSnapshot,
      quantity: item.quantity,
      unitPrice: { amount: item.unitPriceAmount.toString(), currency: item.currency },
      lineTotal: { amount: item.lineTotalAmount.toString(), currency: item.currency },
    })),
    createdAt: quote.createdAt.toISOString(),
  }
}

async function invalidateQuotes(
  transaction: Prisma.TransactionClient,
  cartId: string,
  now: Date,
): Promise<void> {
  await transaction.quote.updateMany({
    where: { cartId, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED', expiresAt: now },
  })
}

async function recordCommerceChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  entityId: string,
  action: string,
  correlationId: string,
  now: Date,
  payload: Prisma.InputJsonObject,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType: 'CUSTOMER',
      actorId: customerId,
      action,
      entityType: action.startsWith('quote.') ? 'quote' : 'cart',
      entityId,
      summary: action.startsWith('quote.') ? 'Server quote created' : 'Server cart changed',
      correlationId,
      occurredAt: now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: action,
      aggregateType: action.startsWith('quote.') ? 'quote' : 'cart',
      aggregateId: entityId,
      actorType: 'CUSTOMER',
      actorId: customerId,
      correlationId,
      consentBasis: 'TRANSACTIONAL',
      payload,
      occurredAt: now,
    },
  })
}

function pathOfferingId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const value = Reflect.get(params, 'offeringId')
  const parsed = uuidSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function currentTime(dependencies: CommerceDependencies): Date {
  return dependencies.now?.() ?? new Date()
}

function commerceFailure(
  request: { log: { error(input: unknown, message: string): void } },
  reply: { code(status: number): { send(payload: ErrorEnvelope): unknown } },
  error: unknown,
): unknown {
  if (error instanceof CommerceError) {
    return reply.code(error.status).send(errorEnvelope(error.code, safeCommerceMessage(error.code)))
  }
  if (error instanceof Error && 'code' in error) {
    const domainCode = String(error.code)
    if (domainCode === 'CART_VERSION_CONFLICT') {
      return reply.code(409).send(errorEnvelope(domainCode, safeCommerceMessage(domainCode)))
    }
    if (domainCode === 'CART_CONTEXT_MISMATCH' || domainCode === 'INVALID_CART_QUANTITY') {
      return reply.code(422).send(errorEnvelope(domainCode, safeCommerceMessage(domainCode)))
    }
  }
  request.log.error({ err: error }, 'Commerce request failed')
  return reply
    .code(503)
    .send(errorEnvelope('COMMERCE_UNAVAILABLE', 'Commerce is temporarily unavailable.'))
}

function safeCommerceMessage(code: string): string {
  const messages: Record<string, string> = {
    CART_NOT_FOUND: 'An active cart was not found.',
    CART_ITEM_NOT_FOUND: 'The cart item was not found.',
    CART_EMPTY: 'The cart has no items.',
    CART_VERSION_CONFLICT: 'The cart changed; refresh it before retrying.',
    CART_CONTEXT_MISMATCH: 'Cart items must use one fulfillment context.',
    INVALID_CART_QUANTITY: 'Cart item quantity is invalid.',
    OFFERING_NOT_FOUND: 'The selected offering was not found.',
    OFFERING_UNAVAILABLE: 'The selected offering is unavailable.',
    CAPACITY_UNAVAILABLE: 'Bakery capacity is unavailable for this quote.',
    IDEMPOTENCY_KEY_CONFLICT: 'The idempotency key was already used.',
  }
  return messages[code] ?? 'The commerce request was rejected.'
}

function responseMeta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
