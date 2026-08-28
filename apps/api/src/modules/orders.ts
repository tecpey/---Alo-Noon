import { randomBytes, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  orderCreateSchema,
  orderCreatedEventPayloadSchema,
  type ErrorEnvelope,
  type OrderCreate,
  type OrderSummary,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  authorizeQuoteToOrder,
  generateOrderCode,
  transitionOrder,
  type CorrelationId,
  type OrderId,
} from '@alo-noon/domain'

import type { AuthDependencies } from './auth.js'
import { authenticatedCustomer, serviceDateAt } from './commerce.js'
import { claimDeliveryWindow } from './delivery-windows.js'
import { consumeRedemptionForQuote } from './promotions.js'

const quoteForOrderInclude = {
  items: {
    orderBy: { id: 'asc' },
    include: { bakeryProductOffering: { select: { stockTracked: true } } },
  },
  deliveryAddress: true,
  deliveryPricingRule: true,
  order: { select: { id: true } },
  // The window this basket was priced for. The order claims its capacity and
  // inherits its end as the deadline everything downstream reads.
  deliveryWindow: { select: { id: true, startsAt: true, endsAt: true, serviceDate: true } },
  cart: {
    include: {
      bakeryBranch: { include: { bakery: true, city: true } },
    },
  },
} satisfies Prisma.QuoteInclude

const orderInclude = { items: { orderBy: { id: 'asc' } } } satisfies Prisma.OrderInclude
type QuoteForOrder = Prisma.QuoteGetPayload<{ include: typeof quoteForOrderInclude }>
type OrderRecord = Prisma.OrderGetPayload<{ include: typeof orderInclude }>

export interface OrderRepository {
  create(
    tenantId: string,
    customerId: string,
    input: OrderCreate,
    now: Date,
    correlationId: string,
  ): Promise<OrderSummary>
  /**
   * The customer's own orders, newest first.
   *
   * Drafts are excluded: a draft is an order the customer never placed, and
   * showing abandoned checkouts back to them as orders would be confusing at
   * best. Bounded rather than paginated — a customer following their bread is
   * looking at the last few, not browsing a history.
   */
  listForCustomer(tenantId: string, customerId: string, limit: number): Promise<OrderSummary[]>
  findForCustomer(
    tenantId: string,
    customerId: string,
    orderId: string,
  ): Promise<OrderSummary | null>
}

export interface OrderDependencies {
  repository: OrderRepository
  auth: AuthDependencies
  now?: () => Date
}

export interface PrismaOrderRepositoryOptions {
  beforeCommit?: (transaction: Prisma.TransactionClient) => Promise<void>
  maxSerializationAttempts?: number
}

export class OrderError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

export function registerOrderRoutes(app: FastifyInstance, dependencies: OrderDependencies): void {
  /**
   * A customer following their own bread.
   *
   * Read-only and scoped to the session's customer. This is where a paid order
   * stops being a void: before it existed, a customer paid and had no way to
   * learn anything ever happened.
   */
  app.get('/api/v1/orders', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    try {
      const orders = await dependencies.repository.listForCustomer(
        customer.tenantId,
        customer.customerId,
        CUSTOMER_ORDER_LIMIT,
      )
      return reply.send({ success: true, data: orders, meta: responseMeta() })
    } catch (error) {
      return orderFailure(request, reply, error)
    }
  })

  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    try {
      const order = await dependencies.repository.findForCustomer(
        customer.tenantId,
        customer.customerId,
        request.params.orderId,
      )
      if (!order) {
        return reply.code(404).send(errorEnvelope('ORDER_NOT_FOUND', 'No such order.'))
      }
      return reply.send({ success: true, data: order, meta: responseMeta() })
    } catch (error) {
      return orderFailure(request, reply, error)
    }
  })

  app.post('/api/v1/orders', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    const parsed = orderCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_ORDER_REQUEST', 'Order request is invalid.'))
    }
    try {
      return reply.code(201).send({
        success: true,
        data: await dependencies.repository.create(
          customer.tenantId,
          customer.customerId,
          parsed.data,
          dependencies.now?.() ?? new Date(),
          randomUUID(),
        ),
        meta: responseMeta(),
      })
    } catch (error) {
      return orderFailure(request, reply, error)
    }
  })
}

export function createPrismaOrderRepository(
  prisma: PrismaClient,
  options: PrismaOrderRepositoryOptions = {},
): OrderRepository {
  return {
    async listForCustomer(tenantId, customerId, limit) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        // ownership-established: filtered on the session's own customerId, so
        // this can only ever return the caller's orders.
        const orders = await transaction.order.findMany({
          where: { tenantId, customerId, state: { not: 'DRAFT' } },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: orderInclude,
        })
        // An order placed before the quote provenance rules existed would throw
        // from `mapOrder`; in a list that would hide every other order behind
        // one bad row, so those are skipped rather than fatal.
        return orders.flatMap((order) => (order.quoteId ? [mapOrder(order)] : []))
      })
    },

    async findForCustomer(tenantId, customerId, orderId) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        // ownership-established: scoped to the session's customerId, so another
        // customer's order reads as absent rather than as a refusal that
        // confirms it exists.
        const order = await transaction.order.findFirst({
          where: { id: orderId, tenantId, customerId, state: { not: 'DRAFT' } },
          include: orderInclude,
        })
        return order ? mapOrder(order) : null
      })
    },

    async create(tenantId, customerId, input, now, correlationId) {
      return serializableWithRetry(
        prisma,
        tenantId,
        options.maxSerializationAttempts ?? 3,
        async (transaction) => {
          const replay = await transaction.order.findFirst({
            where: { tenantId, customerId, idempotencyKey: input.idempotencyKey },
            include: orderInclude,
          })
          if (replay) {
            if (replay.quoteId !== input.quoteId) {
              throw new OrderError('IDEMPOTENCY_KEY_CONFLICT', 409)
            }
            return mapOrder(replay)
          }

          await transaction.$queryRaw`
            SELECT "id" FROM "Quote"
            WHERE "id" = ${input.quoteId}::uuid AND "tenantId" = ${tenantId}::uuid
            FOR UPDATE
          `
          const quote = await transaction.quote.findFirst({
            where: { id: input.quoteId, tenantId, customerId },
            include: quoteForOrderInclude,
          })
          if (!quote) throw new OrderError('QUOTE_NOT_FOUND', 404)

          authorizeQuoteToOrder(
            {
              tenantId: quote.tenantId,
              customerId: quote.customerId,
              expectedTenantId: tenantId,
              expectedCustomerId: customerId,
              status: quote.status,
              expiresAt: quote.expiresAt,
              currency: quote.currency,
              subtotalAmount: quote.subtotalAmount,
              deliveryFeeAmount: quote.deliveryFeeAmount,
              discountAmount: quote.discountAmount,
              totalAmount: quote.totalAmount,
              deliveryAddressId: quote.deliveryAddressId,
              deliveryServiceAreaIdSnapshot: quote.deliveryServiceAreaIdSnapshot,
              deliveryOperationalZoneIdSnapshot: quote.deliveryOperationalZoneIdSnapshot,
              deliveryDistanceMeters: quote.deliveryDistanceMeters,
              bakeryNameSnapshot: quote.bakeryNameSnapshot,
              bakeryPickupSnapshot: quote.bakeryPickupSnapshot,
              deliveryPricingRuleId: quote.deliveryPricingRuleId,
              deliveryPricingRuleVersion: quote.deliveryPricingRuleVersion,
              recipientNameSnapshot: quote.recipientNameSnapshot,
              recipientPhoneSnapshot: quote.recipientPhoneSnapshot,
              deliveryAddressSnapshot: quote.deliveryAddressSnapshot,
              deliveryLatitudeSnapshot: quote.deliveryLatitudeSnapshot,
              deliveryLongitudeSnapshot: quote.deliveryLongitudeSnapshot,
              itemCount: quote.items.length,
              itemSnapshotsComplete: quoteItemsComplete(quote),
              existingOrderId: quote.order?.id ?? null,
            },
            now,
          )
          assertCurrentDependencies(quote, tenantId, customerId, now)

          const branch = quote.cart.bakeryBranch
          // The day whose capacity this order consumes. An order for tomorrow
          // morning must come out of tomorrow's ovens, not today's — reading it
          // from `now` would let a branch take a full day of scheduled orders
          // on top of a full day of immediate ones.
          const serviceDate = quote.deliveryWindow
            ? quote.deliveryWindow.serviceDate
            : serviceDateAt(now, branch.city.timezone)
          const capacitySlot = await transaction.bakeryCapacitySlot.findUnique({
            where: { bakeryBranchId_serviceDate: { bakeryBranchId: branch.id, serviceDate } },
          })
          if (!capacitySlot || capacitySlot.tenantId !== tenantId) {
            throw new OrderError('CAPACITY_UNAVAILABLE', 422)
          }
          const reserved = await transaction.$queryRaw<Array<{ id: string }>>`
            UPDATE "BakeryCapacitySlot"
            SET "reservedOrders" = "reservedOrders" + 1, "updatedAt" = ${now}
            WHERE "id" = ${capacitySlot.id}::uuid
              AND "tenantId" = ${tenantId}::uuid
              AND NOT "suspended"
              AND "reservedOrders" < "maxOrders"
            RETURNING "id"
          `
          if (reserved.length !== 1) throw new OrderError('CAPACITY_UNAVAILABLE', 422)

          // A place in the chosen window, claimed the same way and for the same
          // reason: a bakery that can do two hundred loaves a day cannot get
          // forty of them out of the oven between seven and eight, and the day
          // slot alone cannot say that.
          if (
            quote.deliveryWindow &&
            !(await claimDeliveryWindow(transaction, tenantId, quote.deliveryWindow.id, now))
          ) {
            throw new OrderError('DELIVERY_WINDOW_UNAVAILABLE', 422)
          }

          for (const item of quote.items) {
            if (!item.bakeryProductOffering.stockTracked) continue
            const decremented = await transaction.$queryRaw<Array<{ id: string }>>`
              UPDATE "BakeryProductOffering"
              SET "stockOnHand" = "stockOnHand" - ${item.quantity}, "updatedAt" = ${now}
              WHERE "id" = ${item.bakeryProductOfferingId}::uuid
                AND "tenantId" = ${tenantId}::uuid
                AND "stockTracked"
                AND "stockOnHand" >= ${item.quantity}
              RETURNING "id"
            `
            if (decremented.length !== 1) throw new OrderError('STOCK_UNAVAILABLE', 422)
          }

          const order = await transaction.order.create({
            data: {
              tenantId,
              // The code a customer reads back down the phone. Generated here
              // rather than left to the schema's cuid default, which produced
              // twenty-five characters nobody could read and which pushed every
              // order notification into a second paid SMS. Generated inside the
              // transaction so the unique index's own retry produces a fresh
              // code rather than replaying the collided one.
              publicId: generateOrderCode((length) => randomBytes(length)),
              quoteId: quote.id,
              idempotencyKey: input.idempotencyKey,
              customerId,
              cityId: quote.cart.cityId,
              operationalZoneId: quote.deliveryOperationalZoneIdSnapshot!,
              bakeryBranchId: branch.id,
              bakeryCapacitySlotId: capacitySlot.id,
              ...(quote.deliveryWindow && {
                deliveryWindowId: quote.deliveryWindow.id,
                // The end of the window, not its start: the window is a promise
                // to arrive *by* then, and every deadline downstream — the
                // courier's, the late-delivery report's — reads this field.
                requestedDeliveryAt: quote.deliveryWindow.endsAt,
              }),
              savedAddressId: quote.deliveryAddressId,
              state: 'DRAFT',
              paymentState: 'NOT_STARTED',
              productionState: 'UNSCHEDULED',
              deliveryState: 'UNASSIGNED',
              recipientNameSnapshot: quote.recipientNameSnapshot!,
              recipientPhoneSnapshot: quote.recipientPhoneSnapshot!,
              deliveryAddressSnapshot: quote.deliveryAddressSnapshot!,
              deliveryLatitudeSnapshot: quote.deliveryLatitudeSnapshot!,
              deliveryLongitudeSnapshot: quote.deliveryLongitudeSnapshot!,
              deliveryInstructionsSnapshot: quote.deliveryInstructionsSnapshot,
              bakeryNameSnapshot: quote.bakeryNameSnapshot!,
              bakeryPickupSnapshot: quote.bakeryPickupSnapshot,
              subtotalAmount: quote.subtotalAmount,
              deliveryFeeAmount: quote.deliveryFeeAmount,
              discountAmount: quote.discountAmount,
              totalAmount: quote.totalAmount,
              currency: quote.currency,
              ...(quote.promotionId && { promotionId: quote.promotionId }),
              items: {
                create: quote.items.map((item) => ({
                  tenantId,
                  productVariantId: item.productVariantId,
                  bakeryProductOfferingId: item.bakeryProductOfferingId,
                  skuSnapshot: item.skuSnapshot,
                  productNameFaSnapshot: item.productNameFaSnapshot!,
                  variantNameFaSnapshot: item.nameFaSnapshot,
                  fulfillmentClassSnapshot: item.fulfillmentClassSnapshot,
                  freshnessClaimSnapshot: item.freshnessClaimSnapshot,
                  packagingTypeSnapshot: item.packagingTypeSnapshot,
                  quantity: item.quantity,
                  unitPriceAmount: item.unitPriceAmount,
                  lineTotalAmount: item.lineTotalAmount,
                  currency: item.currency,
                })),
              },
            },
            include: orderInclude,
          })

          // The campaign's budget is spent here and nowhere earlier. Until this
          // moment the redemption was only held, so a customer who priced a
          // basket and walked away cost the campaign nothing.
          await consumeRedemptionForQuote(transaction, tenantId, quote.id, order.id)

          const transitionIdempotencyKey = `order-created-${order.id}`
          transitionOrder({
            orderId: order.id as OrderId,
            from: 'DRAFT',
            to: 'PENDING_CONFIRMATION',
            actor: 'CUSTOMER',
            occurredAt: now,
            idempotencyKey: transitionIdempotencyKey,
            correlationId: correlationId as CorrelationId,
          })
          await transaction.orderStateTransition.create({
            data: {
              tenantId,
              orderId: order.id,
              fromState: 'DRAFT',
              toState: 'PENDING_CONFIRMATION',
              actorType: 'CUSTOMER',
              actorId: customerId,
              idempotencyKey: transitionIdempotencyKey,
              correlationId,
              occurredAt: now,
            },
          })
          // ownership-established: order was just created for this customerId,
          // and quote/cart were resolved under the same customerId filter above.
          await transaction.order.update({
            where: { id: order.id },
            data: { state: 'PENDING_CONFIRMATION' },
          })
          // ownership-established: quote was resolved under this customerId above.
          const quoteAccepted = await transaction.quote.updateMany({
            where: { id: quote.id, status: 'ACTIVE' },
            data: { status: 'ACCEPTED' },
          })
          if (quoteAccepted.count !== 1) throw new OrderError('QUOTE_NOT_ACTIVE', 409)
          // ownership-established: cart is the one referenced by that same quote.
          await transaction.cart.update({
            where: { id: quote.cartId },
            data: { state: 'CONVERTED' },
          })

          const eventPayload = orderCreatedEventPayloadSchema.parse({
            orderId: order.id,
            quoteId: quote.id,
            customerId,
            bakeryBranchId: branch.id,
            bakeryCapacitySlotId: capacitySlot.id,
            state: 'PENDING_CONFIRMATION',
            totalAmount: quote.totalAmount.toString(),
            currency: quote.currency,
          })
          await Promise.all([
            transaction.auditEvent.create({
              data: {
                tenantId,
                actorType: 'CUSTOMER',
                actorId: customerId,
                action: 'order.created',
                entityType: 'order',
                entityId: order.id,
                summary: 'Quote converted to a capacity-backed order',
                correlationId,
                metadata: { quoteId: quote.id, bakeryCapacitySlotId: capacitySlot.id },
                occurredAt: now,
              },
            }),
            transaction.domainEventOutbox.create({
              data: {
                tenantId,
                eventId: order.id,
                name: 'order.created',
                aggregateType: 'order',
                aggregateId: order.id,
                actorType: 'CUSTOMER',
                actorId: customerId,
                correlationId,
                consentBasis: 'TRANSACTIONAL',
                payload: eventPayload,
                occurredAt: now,
              },
            }),
          ])
          await options.beforeCommit?.(transaction)

          // ownership-established: re-reads the order just created for this customerId.
          const completed = await transaction.order.findUnique({
            where: { id: order.id },
            include: orderInclude,
          })
          if (!completed) throw new OrderError('ORDER_CREATION_FAILED', 503)
          return mapOrder(completed)
        },
      )
    },
  }
}

function assertCurrentDependencies(
  quote: QuoteForOrder,
  tenantId: string,
  customerId: string,
  now: Date,
): void {
  const address = quote.deliveryAddress
  const rule = quote.deliveryPricingRule
  const branch = quote.cart.bakeryBranch
  if (
    !address ||
    address.tenantId !== tenantId ||
    address.customerId !== customerId ||
    address.archivedAt ||
    address.verificationState === 'REJECTED' ||
    !address.serviceAreaId ||
    !address.operationalZoneId
  )
    throw new OrderError('QUOTE_DEPENDENCY_UNAVAILABLE', 404)
  if (
    !rule ||
    rule.tenantId !== tenantId ||
    rule.version !== quote.deliveryPricingRuleVersion ||
    rule.currency !== quote.currency ||
    rule.cityId !== quote.cart.cityId ||
    (rule.operationalZoneId !== null &&
      rule.operationalZoneId !== quote.deliveryOperationalZoneIdSnapshot) ||
    !rule.isActive ||
    rule.effectiveFrom > now ||
    (rule.effectiveUntil !== null && rule.effectiveUntil <= now)
  )
    throw new OrderError('QUOTE_PRICING_UNAVAILABLE', 422)
  if (
    branch.tenantId !== tenantId ||
    branch.operationalStatus !== 'ACTIVE' ||
    branch.qualityStatus !== 'APPROVED'
  )
    throw new OrderError('BAKERY_BRANCH_UNAVAILABLE', 422)
  if (quote.cart.state !== 'ACTIVE' || quote.cart.version !== quote.cartVersion) {
    throw new OrderError('QUOTE_NOT_ACTIVE', 409)
  }
}

function quoteItemsComplete(quote: QuoteForOrder): boolean {
  let subtotal = 0n
  for (const item of quote.items) {
    const packaged =
      item.fulfillmentClassSnapshot === 'PACKAGED_TRADITIONAL' ||
      item.fulfillmentClassSnapshot === 'PACKAGED_FANTASY' ||
      item.fulfillmentClassSnapshot === 'PACKAGED_DIETARY'
    if (
      !item.productNameFaSnapshot?.trim() ||
      (packaged && item.packagingTypeSnapshot === null) ||
      item.bakeryBranchId !== quote.cart.bakeryBranchId ||
      item.currency !== quote.currency ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.unitPriceAmount < 0n ||
      item.lineTotalAmount !== item.unitPriceAmount * BigInt(item.quantity)
    ) {
      return false
    }
    subtotal += item.lineTotalAmount
  }
  return subtotal === quote.subtotalAmount
}

async function serializableWithRetry<T>(
  prisma: PrismaClient,
  tenantId: string,
  maxAttempts: number,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          return operation(transaction)
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === maxAttempts) {
        if (isSerializationFailure(error)) throw new OrderError('ORDER_CONCURRENCY_CONFLICT', 409)
        throw error
      }
    }
  }
  throw new OrderError('ORDER_CONCURRENCY_CONFLICT', 409)
}

export function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  if (code === 'P2034' || code === 'P2002' || code === '40001') return true

  const meta = Reflect.get(error, 'meta')
  return (
    code === 'P2010' &&
    typeof meta === 'object' &&
    meta !== null &&
    Reflect.get(meta, 'code') === '40001'
  )
}

/**
 * A tenant-scoped read. ReadCommitted because a customer refreshing their order
 * must never contend with the settlement trying to capture its payment.
 */
async function readTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/** How many recent orders a customer sees without asking for more. */
export const CUSTOMER_ORDER_LIMIT = 20

function mapOrder(order: OrderRecord): OrderSummary {
  if (!order.quoteId) throw new OrderError('ORDER_PROVENANCE_INCOMPLETE', 503)
  return {
    id: order.id,
    publicId: order.publicId,
    quoteId: order.quoteId,
    state: order.state,
    paymentState: order.paymentState,
    productionState: order.productionState,
    deliveryState: order.deliveryState,
    subtotal: { amount: order.subtotalAmount.toString(), currency: order.currency },
    deliveryFee: { amount: order.deliveryFeeAmount.toString(), currency: order.currency },
    discount: { amount: order.discountAmount.toString(), currency: order.currency },
    total: { amount: order.totalAmount.toString(), currency: order.currency },
    items: order.items.map((item) => ({
      id: item.id,
      skuSnapshot: item.skuSnapshot,
      nameFaSnapshot: item.variantNameFaSnapshot,
      fulfillmentClassSnapshot: item.fulfillmentClassSnapshot,
      quantity: item.quantity,
      unitPrice: { amount: item.unitPriceAmount.toString(), currency: item.currency },
      lineTotal: { amount: item.lineTotalAmount.toString(), currency: item.currency },
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  }
}

function orderFailure(
  request: { log: { error(input: unknown, message: string): void } },
  reply: { code(status: number): { send(payload: ErrorEnvelope): unknown } },
  error: unknown,
) {
  const code =
    error instanceof OrderError
      ? error.code
      : error instanceof Error && 'code' in error
        ? String(error.code)
        : undefined
  const statuses: Record<string, 404 | 409 | 422 | 503> = {
    QUOTE_NOT_FOUND: 404,
    QUOTE_OWNERSHIP_MISMATCH: 404,
    QUOTE_DEPENDENCY_UNAVAILABLE: 404,
    IDEMPOTENCY_KEY_CONFLICT: 409,
    QUOTE_ALREADY_ACCEPTED: 409,
    QUOTE_NOT_ACTIVE: 409,
    QUOTE_EXPIRED: 409,
    ORDER_CONCURRENCY_CONFLICT: 409,
    QUOTE_EMPTY: 422,
    QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE: 422,
    QUOTE_TOTAL_MISMATCH: 422,
    QUOTE_PRICING_UNAVAILABLE: 422,
    BAKERY_BRANCH_UNAVAILABLE: 422,
    CAPACITY_UNAVAILABLE: 422,
    STOCK_UNAVAILABLE: 422,
  }
  if (code && statuses[code]) {
    const messages: Record<string, string> = {
      QUOTE_NOT_FOUND: 'The quote is not available.',
      QUOTE_OWNERSHIP_MISMATCH: 'The quote is not available.',
      QUOTE_DEPENDENCY_UNAVAILABLE: 'The quote is not available.',
      IDEMPOTENCY_KEY_CONFLICT: 'The idempotency key was already used.',
      QUOTE_ALREADY_ACCEPTED: 'The quote was already accepted.',
      QUOTE_NOT_ACTIVE: 'The quote is not active.',
      QUOTE_EXPIRED: 'The quote has expired.',
      ORDER_CONCURRENCY_CONFLICT: 'Order creation conflicted; retry safely.',
      CAPACITY_UNAVAILABLE: 'Bakery capacity is unavailable.',
      STOCK_UNAVAILABLE: 'One or more items are out of stock.',
    }
    return reply
      .code(statuses[code]!)
      .send(errorEnvelope(code, messages[code] ?? 'Order request rejected.'))
  }
  request.log.error({ err: error }, 'Order creation failed')
  return reply
    .code(503)
    .send(errorEnvelope('ORDER_SERVICE_UNAVAILABLE', 'Order service is temporarily unavailable.'))
}

function responseMeta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}
function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
