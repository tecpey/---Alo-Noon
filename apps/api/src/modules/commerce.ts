import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  cartItemMutationSchema,
  cartItemRemovalSchema,
  quoteCreateSchema,
  uuidSchema,
  type CartItemMutation,
  type CartSummary,
  type DeliveryWindow,
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
  calculateDeliveryDistanceMeters,
  calculateDeliveryFee,
  calculateCartLine,
  calculateQuoteExpiry,
  selectDeliveryPricingRule,
  totalAfterDiscount,
  type RouteDistance,
} from '@alo-noon/domain'

import { authenticateRequest, type AuthDependencies } from './auth.js'
import {
  listDeliveryWindows as listBranchDeliveryWindows,
  resolveDeliveryWindow,
} from './delivery-windows.js'
import {
  attachRedemptionToQuote,
  releaseRedemptionsForQuotes,
  reservePromotion,
} from './promotions.js'
import type { RoutingService } from './routing.js'

const cartInclude = {
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      bakeryProductOffering: {
        include: {
          bakeryBranch: { include: { bakery: true, city: true } },
          productVariant: { include: { product: true } },
        },
      },
    },
  },
} satisfies Prisma.CartInclude

const quoteInclude = {
  items: { orderBy: { id: 'asc' } },
  // So the quote can name the campaign that discounted it. A customer reading
  // "۱۰٬۰۰۰ تومان تخفیف" with no idea which code produced it cannot tell a
  // working code from a coincidence.
  promotion: { select: { nameFa: true } },
  promotionRedemption: { select: { basis: true } },
  // So the quote can restate the window it was priced for. The customer agreed
  // to a time, and a summary that omits it is a summary of a different order.
  deliveryWindow: { select: { startsAt: true, endsAt: true } },
} satisfies Prisma.QuoteInclude

type CartRecord = Prisma.CartGetPayload<{ include: typeof cartInclude }>
type QuoteRecord = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>
type OfferingRecord = Prisma.BakeryProductOfferingGetPayload<{
  include: {
    bakeryBranch: { include: { bakery: true; city: true } }
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
  /**
   * The delivery windows the customer's own basket can be booked into.
   *
   * Derived from the branch their cart is already against rather than from a
   * branch identifier in the request. There is nothing to authorise because
   * there is nothing to name: a customer can only ever ask about their own
   * basket's bakery.
   */
  listDeliveryWindows(tenantId: string, customerId: string, now: Date): Promise<DeliveryWindow[]>
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

  /**
   * When the bakery can bring it.
   *
   * Read-only and derived entirely from the customer's own basket, so there is
   * nothing to authorise beyond the session. Enumerating windows writes
   * nothing: a customer browsing times costs the platform a schedule lookup,
   * not a row, which is what keeps a shopper who never buys from filling a
   * table.
   */
  app.get('/api/v1/cart/delivery-windows', async (request, reply) => {
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
        data: await dependencies.repository.listDeliveryWindows(
          session.tenantId,
          session.customerId,
          currentTime(dependencies),
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

/**
 * How far it is, and where that came from.
 *
 * The routing service is optional: without one, quotes are priced exactly as
 * they were before — on the straight line — and nothing else changes. That is
 * what lets routing be adopted per deployment rather than being a prerequisite
 * for selling bread.
 */
export interface PrismaCommerceOptions {
  routingService?: RoutingService
}

export function createPrismaCommerceRepository(
  prisma: PrismaClient,
  options: PrismaCommerceOptions = {},
): CommerceRepository {
  /**
   * Resolved before the quote's transaction opens, never inside it.
   *
   * Routing is a call to another company's server, and ADR-0010 keeps those out
   * of database transactions for a reason that is sharper here than usual: this
   * transaction is SERIALIZABLE and holds locks a checkout depends on. A routing
   * engine having a slow afternoon would become a checkout having one.
   *
   * The context is read first without a transaction, so a replay or a missing
   * cart costs no routing call at all.
   */
  async function resolveDistance(
    tenantId: string,
    customerId: string,
    input: QuoteCreate,
    now: Date,
  ): Promise<{ branchId: string; addressId: string; distance: RouteDistance } | null> {
    if (!options.routingService) return null
    const context = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      const replay = await transaction.quote.findFirst({
        where: { idempotencyKey: input.idempotencyKey, tenantId, customerId },
        select: { id: true },
      })
      if (replay) return null
      // ownership-established: both reads below are filtered by customerId, so a
      // cart or address belonging to anyone else is simply not found.
      const cart = await transaction.cart.findFirst({
        where: { tenantId, customerId, state: 'ACTIVE' },
        select: {
          bakeryBranchId: true,
          bakeryBranch: { select: { id: true, latitude: true, longitude: true } },
        },
      })
      const address = await transaction.address.findFirst({
        where: { id: input.deliveryAddressId, tenantId, customerId, archivedAt: null },
        select: { id: true, latitude: true, longitude: true },
      })
      return cart?.bakeryBranch && address ? { branch: cart.bakeryBranch, address } : null
    })
    if (!context) return null

    const distance = await options.routingService.distanceFor(
      tenantId,
      {
        branchId: context.branch.id,
        origin: {
          latitude: Number(context.branch.latitude),
          longitude: Number(context.branch.longitude),
        },
        destination: {
          latitude: Number(context.address.latitude),
          longitude: Number(context.address.longitude),
        },
      },
      now,
    )
    return { branchId: context.branch.id, addressId: context.address.id, distance }
  }

  return {
    async getCart(tenantId, customerId) {
      return serializable(prisma, tenantId, async (transaction) => {
        const cart = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          include: cartInclude,
        })
        return cart ? mapCart(cart) : null
      })
    },

    async listDeliveryWindows(tenantId, customerId, now) {
      return serializable(prisma, tenantId, async (transaction) => {
        const cart = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          select: { bakeryBranchId: true },
        })
        if (!cart) return []
        const windows = await listBranchDeliveryWindows(
          transaction,
          tenantId,
          cart.bakeryBranchId,
          now,
        )
        return windows.map((window) => ({
          serviceDate: window.serviceDate,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          remaining: window.remaining,
          available: window.available,
        }))
      })
    },

    async upsertItem(tenantId, customerId, offeringId, input, now, correlationId) {
      return serializable(prisma, tenantId, async (transaction) => {
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
          // ownership-established: cart was loaded above filtered by customerId.
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
      return serializable(prisma, tenantId, async (transaction) => {
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
        // ownership-established: cart was loaded above filtered by customerId.
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
      const routed = await resolveDistance(tenantId, customerId, input, now)
      return serializable(prisma, tenantId, async (transaction) => {
        const replay = await transaction.quote.findFirst({
          where: { idempotencyKey: input.idempotencyKey, tenantId, customerId },
          include: quoteInclude,
        })
        if (replay) {
          if (
            replay.cartVersion !== input.expectedCartVersion ||
            replay.deliveryAddressId !== input.deliveryAddressId
          ) {
            throw new CommerceError('IDEMPOTENCY_KEY_CONFLICT', 409)
          }
          if (replay.status === 'ACTIVE' && replay.expiresAt <= now) {
            // ownership-established: replay was found filtered by customerId.
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

        const address = await transaction.address.findFirst({
          where: {
            id: input.deliveryAddressId,
            tenantId,
            customerId,
            archivedAt: null,
            verificationState: { not: 'REJECTED' },
            serviceAreaId: { not: null },
            operationalZoneId: { not: null },
          },
          include: { serviceArea: true },
        })
        if (!address || !address.serviceAreaId || !address.operationalZoneId) {
          throw new CommerceError('ADDRESS_NOT_FOUND', 404)
        }
        if (
          address.cityId !== cart.cityId ||
          address.operationalZoneId !== cart.operationalZoneId ||
          !address.serviceArea?.isActive
        ) {
          throw new CommerceError('ADDRESS_CONTEXT_MISMATCH', 422)
        }

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
            productNameFaSnapshot: offering.productVariant.product.nameFa,
            packagingTypeSnapshot: offering.productVariant.packagingType,
            fulfillmentClassSnapshot: offering.productVariant.fulfillmentClass,
            freshnessClaimSnapshot: offering.productVariant.freshnessClaim,
            quantity: item.quantity,
            unitPriceAmount: unitPrice.amount,
            lineTotalAmount: lineTotal.amount,
            currency: 'IRR' as const,
          })
        }
        await assertBranchCapacity(transaction, cart.items[0]!.bakeryProductOffering, now)

        const branch = cart.items[0]!.bakeryProductOffering.bakeryBranch
        // The distance was measured against the branch and address read a moment
        // ago. If either moved under us — a cart switched branches between the
        // two reads — that measurement is about a different journey, and using it
        // would price this one on someone else's road.
        const routeDistance =
          routed && routed.branchId === branch.id && routed.addressId === address.id
            ? routed.distance
            : null
        const distanceMeters =
          routeDistance?.distanceMetres ??
          calculateDeliveryDistanceMeters(
            { latitude: Number(branch.latitude), longitude: Number(branch.longitude) },
            { latitude: Number(address.latitude), longitude: Number(address.longitude) },
          )
        const pricingRules = await transaction.deliveryPricingRule.findMany({
          where: {
            tenantId,
            cityId: cart.cityId,
            isActive: true,
            effectiveFrom: { lte: now },
            AND: [
              { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] },
              { OR: [{ operationalZoneId: cart.operationalZoneId }, { operationalZoneId: null }] },
            ],
          },
          orderBy: [{ operationalZoneId: 'asc' }, { version: 'desc' }],
        })
        const pricingRule = selectDeliveryPricingRule(
          pricingRules.map((rule) => ({
            id: rule.id,
            operationalZoneId: rule.operationalZoneId,
            version: rule.version,
            mode: rule.calculationMode,
            baseFeeAmount: rule.baseFeeAmount,
            perKmFeeAmount: rule.perKilometerFeeAmount,
            minimumOrderAmount: rule.minimumOrderAmount,
            freeDeliveryThresholdAmount: rule.freeDeliveryThreshold,
            currency: rule.currency,
          })),
          cart.operationalZoneId,
        )
        const delivery = calculateDeliveryFee(pricingRule, subtotal.amount, distanceMeters)

        // A code the customer supplied. A refusal does not fail the quote: a
        // basket that will not price because a code expired is a basket that
        // gets abandoned. The quote comes back undiscounted and says why.
        const promotion = input.promotionCode
          ? await reservePromotion(transaction, tenantId, customerId, {
              code: input.promotionCode,
              subtotal: subtotal.amount,
              deliveryFee: delivery.deliveryFeeAmount,
              cityId: cart.cityId,
              now,
              correlationId,
            })
          : null
        // The window the customer chose, if they chose one. Re-derived from the
        // branch's own schedule rather than trusted: the start arrives from a
        // browser, and without checking it an order could be accepted for three
        // in the morning. A refusal here is reported, not thrown — a window that
        // filled while the customer was typing their address means "pick
        // another one", not an error page.
        const chosenWindow = input.deliveryWindowStartsAt
          ? await resolveDeliveryWindow(
              transaction,
              tenantId,
              cart.bakeryBranchId,
              new Date(input.deliveryWindowStartsAt),
              now,
            )
          : null
        const windowRefused = Boolean(input.deliveryWindowStartsAt) && chosenWindow === null

        const discountAmount = promotion?.applied ? promotion.discountAmount : 0n
        const total = Money.irr(
          totalAfterDiscount({
            subtotal: subtotal.amount,
            deliveryFee: delivery.deliveryFeeAmount,
            discountAmount,
          }),
        )

        // ownership-established: scoped to a cart loaded above filtered by customerId.
        const superseded = await transaction.quote.findMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          select: { id: true },
        })
        // ownership-established: same cart, loaded above filtered by customerId.
        await transaction.quote.updateMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED' },
        })
        // The holds those quotes carried go back to the campaign. Without this a
        // customer who re-prices their basket twice exhausts their own
        // per-customer limit against quotes nobody will ever pay.
        await releaseRedemptionsForQuotes(
          transaction,
          tenantId,
          superseded.map((entry) => entry.id),
          now,
        )

        const quote = await transaction.quote.create({
          data: {
            tenantId,
            idempotencyKey: input.idempotencyKey,
            cartId: cart.id,
            customerId,
            cartVersion: cart.version,
            expiresAt: calculateQuoteExpiry(now),
            subtotalAmount: subtotal.amount,
            deliveryFeeAmount: delivery.deliveryFeeAmount,
            discountAmount,
            totalAmount: total.amount,
            ...(promotion?.applied && { promotionId: promotion.promotionId }),
            ...(chosenWindow && { deliveryWindowId: chosenWindow.id }),
            deliveryAddressId: address.id,
            deliveryServiceAreaIdSnapshot: address.serviceAreaId,
            deliveryOperationalZoneIdSnapshot: address.operationalZoneId,
            deliveryDistanceMeters: distanceMeters,
            // Recorded so a disputed fare can be explained rather than defended.
            ...(routeDistance && {
              deliveryDistanceSource: routeDistance.source,
              ...(routeDistance.reasonCode !== undefined && {
                deliveryDistanceReasonCode: routeDistance.reasonCode,
              }),
            }),
            deliveryPricingRuleId: pricingRule.id,
            deliveryPricingRuleVersion: pricingRule.version,
            bakeryNameSnapshot: branch.bakery.displayNameFa,
            bakeryPickupSnapshot: [branch.addressLine, branch.pickupInstructions]
              .filter(Boolean)
              .join(' — '),
            recipientNameSnapshot: address.recipientName,
            recipientPhoneSnapshot: address.recipientPhoneE164,
            deliveryAddressSnapshot: address.addressLine,
            deliveryLatitudeSnapshot: address.latitude,
            deliveryLongitudeSnapshot: address.longitude,
            deliveryInstructionsSnapshot: address.deliveryInstructions,
            items: { create: quoteItems },
          },
          include: quoteInclude,
        })
        // The hold now belongs to a quote, which is what lets it be released
        // when that quote is superseded and spent when it becomes an order.
        if (promotion?.applied && promotion.redemptionId) {
          await attachRedemptionToQuote(transaction, promotion.redemptionId, quote.id)
        }
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
            deliveryAddressId: address.id,
            deliveryPricingRuleId: pricingRule.id,
            deliveryPricingRuleVersion: pricingRule.version,
            deliveryDistanceMeters: distanceMeters,
            expiresAt: quote.expiresAt.toISOString(),
          },
        )
        // The refusal is transient: it describes what happened to the code on
        // this request, not a property of the quote. Storing it would mean a
        // customer re-reading an old quote is told again about a code they have
        // long since replaced.
        return {
          ...mapQuote(quote),
          ...(promotion && !promotion.applied && { promotionRefusal: promotion.reason }),
          ...(windowRefused && { deliveryWindowRefusal: 'DELIVERY_WINDOW_UNAVAILABLE' }),
        }
      })
    },
  }
}

async function serializable<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return operation(transaction)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'P2034') {
      throw new CommerceError('CART_VERSION_CONFLICT', 409)
    }
    throw error
  }
}

export async function authenticatedCustomer(
  request: Parameters<typeof authenticateRequest>[0],
  auth: AuthDependencies,
): Promise<{ tenantId: string; customerId: string; session: SessionContext } | null> {
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
      bakeryBranch: { include: { bakery: true, city: true } },
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

export function serviceDateAt(now: Date, timezone: string): Date {
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

/**
 * Internal helper. Callers must pass a cartId they resolved under a customerId
 * filter — never one taken from request input, which would read another
 * customer's cart.
 */
async function loadCart(
  transaction: Prisma.TransactionClient,
  cartId: string,
): Promise<CartSummary> {
  // ownership-established: callers resolve cartId under a customerId filter.
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
  if (
    !quote.deliveryAddressId ||
    !quote.deliveryServiceAreaIdSnapshot ||
    !quote.deliveryOperationalZoneIdSnapshot ||
    quote.deliveryDistanceMeters === null ||
    !quote.deliveryPricingRuleId ||
    quote.deliveryPricingRuleVersion === null
  ) {
    throw new CommerceError('QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE', 422)
  }
  return {
    id: quote.id,
    publicId: quote.publicId,
    cartId: quote.cartId,
    cartVersion: quote.cartVersion,
    status: quote.status,
    expiresAt: quote.expiresAt.toISOString(),
    deliveryAddressId: quote.deliveryAddressId,
    deliveryServiceAreaId: quote.deliveryServiceAreaIdSnapshot,
    deliveryOperationalZoneId: quote.deliveryOperationalZoneIdSnapshot,
    deliveryDistanceMeters: quote.deliveryDistanceMeters,
    deliveryPricingRuleId: quote.deliveryPricingRuleId,
    deliveryPricingRuleVersion: quote.deliveryPricingRuleVersion,
    subtotal: { amount: quote.subtotalAmount.toString(), currency: quote.currency },
    deliveryFee: { amount: quote.deliveryFeeAmount.toString(), currency: quote.currency },
    discount: { amount: quote.discountAmount.toString(), currency: quote.currency },
    ...(quote.promotion && {
      promotion: {
        nameFa: quote.promotion.nameFa,
        basis: quote.promotionRedemption?.basis ?? 'SUBTOTAL',
      },
    }),
    ...(quote.deliveryWindow && {
      deliveryWindow: {
        startsAt: quote.deliveryWindow.startsAt.toISOString(),
        endsAt: quote.deliveryWindow.endsAt.toISOString(),
      },
    }),
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
  // ownership-established: callers resolve cartId under a customerId filter.
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
    if (
      [
        'DELIVERY_PRICING_RULE_MISSING',
        'DELIVERY_PRICING_RULE_AMBIGUOUS',
        'MINIMUM_ORDER_NOT_MET',
        'INVALID_DELIVERY_PRICING_RULE',
        'INVALID_DELIVERY_PRICING_INPUT',
      ].includes(domainCode)
    ) {
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
    ADDRESS_NOT_FOUND: 'The delivery address was not found.',
    ADDRESS_CONTEXT_MISMATCH: 'The delivery address does not match the cart context.',
    DELIVERY_PRICING_RULE_MISSING: 'Delivery pricing is unavailable for this address.',
    DELIVERY_PRICING_RULE_AMBIGUOUS: 'Delivery pricing could not be resolved safely.',
    MINIMUM_ORDER_NOT_MET: 'The cart does not meet the minimum order amount.',
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
