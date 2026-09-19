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
  deliveryVehicleOptions,
  estimateRouteDistance,
  requiredDeliveryVehicle,
  vehicleChoiceAllowed,
  vehiclePolicyForCity,
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
import { chooseFare, type DeliveryFareService, type ProviderFareOffer } from './delivery-fare.js'
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
  /**
   * Who prices the delivery. Optional for the same reason routing is: a
   * deployment without one still sells bread, on the published tariff.
   */
  fareService?: DeliveryFareService
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
  ): Promise<{
    branchId: string
    addressId: string
    distance: RouteDistance
    offer: ProviderFareOffer | null
  } | null> {
    if (!options.routingService && !options.fareService) return null
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
          cityId: true,
          bakeryBranch: { select: { id: true, latitude: true, longitude: true } },
          // Only the quantities: a marketplace prices the trip, and the money is
          // computed authoritatively inside the transaction below.
          items: { select: { quantity: true } },
        },
      })
      const address = await transaction.address.findFirst({
        where: { id: input.deliveryAddressId, tenantId, customerId, archivedAt: null },
        select: { id: true, latitude: true, longitude: true, serviceAreaId: true },
      })
      if (!cart?.bakeryBranch || !address) return null
      const city = await transaction.city.findFirst({
        where: { id: cart.cityId, tenantId },
        select: { motorcycleItemLimit: true, motorcycleRangeMetres: true },
      })
      const serviceArea = address.serviceAreaId
        ? await transaction.serviceArea.findFirst({
            where: { id: address.serviceAreaId, tenantId },
            select: { motorcycleAllowed: true },
          })
        : null
      return { branch: cart.bakeryBranch, address, cart, city, serviceArea }
    })
    if (!context) return null

    const origin = {
      latitude: Number(context.branch.latitude),
      longitude: Number(context.branch.longitude),
    }
    const destination = {
      latitude: Number(context.address.latitude),
      longitude: Number(context.address.longitude),
    }

    const distance = options.routingService
      ? await options.routingService.distanceFor(
          tenantId,
          { branchId: context.branch.id, origin, destination },
          now,
        )
      : estimateRouteDistance(origin, destination, 'ROUTING_NOT_CONFIGURED')

    /**
     * The marketplace's price, asked here rather than inside the transaction.
     *
     * Same reasoning as the distance above, and it matters more: the quote runs
     * SERIALIZABLE and holds locks a checkout depends on, so a courier platform
     * having a slow afternoon would become a checkout having one.
     *
     * The vehicle is derived here too, because the provider has to be told what
     * it is pricing. It is derived again authoritatively inside the transaction,
     * and if the two disagree — a threshold moved, or the address resolved into
     * a different area — `chooseFare` discards this offer rather than charging a
     * motorcycle price for a car. Deriving it twice is the cost of not holding a
     * lock across somebody else's network.
     */
    const itemCount = context.cart.items.reduce((total, item) => total + item.quantity, 0)
    const profile = requiredDeliveryVehicle(
      {
        itemCount,
        distanceMetres: distance.distanceMetres,
        ...(context.serviceArea && {
          motorcycleAllowedInArea: context.serviceArea.motorcycleAllowed,
        }),
      },
      vehiclePolicyForCity(context.city),
    ).profile
    const offer = options.fareService
      ? await options.fareService.offerFromProvider(
          tenantId,
          {
            origin,
            destination,
            profile,
            distanceMetres: distance.distanceMetres,
            durationSeconds: distance.durationSeconds,
            itemCount,
          },
          { branchId: context.branch.id, addressId: context.address.id, profile },
          now,
        )
      : null

    return { branchId: context.branch.id, addressId: context.address.id, distance, offer }
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
        /**
         * What this order has to go out in.
         *
         * Derived before the tariff is chosen, because it decides which tariff
         * applies: a car is a separate rate, not a surcharge on the motorcycle
         * one. Derived at all because the customer is standing at a checkout and
         * has to be told before they pay, and because by dispatch the thresholds
         * may have moved and an order already paid for must keep meaning what it
         * meant when it was accepted.
         *
         * Thresholds come from the city rather than from a constant: Babol is a
         * few kilometres across with its estates on the ring road, and a city
         * the size of Tehran has neither property.
         */
        const cityPolicy = await transaction.city.findFirst({
          where: { id: cart.cityId, tenantId },
          // The timezone rides along because the fare below asks what time of
          // day it is *here*. "Is it the breakfast rush" is a question about
          // Babol's clock, and a server's clock is neither here nor there.
          select: { motorcycleItemLimit: true, motorcycleRangeMetres: true, timezone: true },
        })
        const cityTimeZone = cityPolicy?.timezone ?? 'Asia/Tehran'
        // Whether this address's area takes motorcycles at all. Read from the
        // area the address resolved to rather than from the city, because the
        // village that does not take them and the city centre that does are
        // both in the same city.
        const serviceArea = address.serviceAreaId
          ? await transaction.serviceArea.findFirst({
              where: { id: address.serviceAreaId, tenantId },
              select: { motorcycleAllowed: true },
            })
          : null

        const availability = {
          itemCount: cart.items.reduce((total, item) => total + item.quantity, 0),
          distanceMetres: distanceMeters,
          ...(serviceArea && { motorcycleAllowedInArea: serviceArea.motorcycleAllowed }),
        }
        const policy = vehiclePolicyForCity(cityPolicy)
        const choice = deliveryVehicleOptions(availability, policy)

        /**
         * The customer's pick, checked rather than trusted.
         *
         * The interface disables an unavailable option; that is a courtesy, and
         * this is the enforcement. Refused rather than silently corrected: a
         * customer who chose the motorcycle and was quietly given the car fare
         * would be right to call that a bait, and one whose four hundred loaves
         * were quietly accepted onto a motorcycle would find out at the door.
         */
        if (
          input.deliveryVehicleProfile &&
          !vehicleChoiceAllowed(choice, input.deliveryVehicleProfile)
        ) {
          throw new CommerceError('DELIVERY_VEHICLE_UNAVAILABLE', 422)
        }
        const vehicle = requiredDeliveryVehicle(availability, policy)
        const chosenProfile = input.deliveryVehicleProfile ?? choice.fallback

        const pricingRules = await transaction.deliveryPricingRule.findMany({
          where: {
            tenantId,
            cityId: cart.cityId,
            isActive: true,
            effectiveFrom: { lte: now },
            // Every vehicle's tariffs, not just the one needed. Narrowing here
            // would make "this city has no pricing" and "this city has no car
            // rate" arrive at selection as the same empty list, and they need
            // different things said to the operator.
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
            vehicleProfile: rule.vehicleProfile,
            version: rule.version,
            mode: rule.calculationMode,
            baseFeeAmount: rule.baseFeeAmount,
            perKmFeeAmount: rule.perKilometerFeeAmount,
            minimumOrderAmount: rule.minimumOrderAmount,
            freeDeliveryThresholdAmount: rule.freeDeliveryThreshold,
            currency: rule.currency,
          })),
          cart.operationalZoneId,
          chosenProfile,
        )
        const delivery = calculateDeliveryFee(pricingRule, subtotal.amount, distanceMeters)

        /**
         * What the customer is actually charged to have this delivered.
         *
         * The tariff above is no longer the answer — it is the floor and the
         * fallback. A published rate prices every journey as though the only
         * thing that varies is its length, which is wrong about the market when
         * somebody else is carrying the bread and wrong about the moment when
         * breakfast lands in a ninety-minute window.
         *
         * `chooseFare` decides here rather than outside, because only here are
         * the tariff amount and the vehicle authoritative. An offer quoted for a
         * different branch, address or vehicle is discarded — those were priced
         * for a different journey.
         */
        const own = options.fareService
          ? await options.fareService.ownFare(
              tenantId,
              { tariffAmount: delivery.deliveryFeeAmount, timeZone: cityTimeZone },
              now,
            )
          : null
        const fare = own
          ? chooseFare(
              delivery.deliveryFeeAmount,
              routed?.offer ?? null,
              { branchId: branch.id, addressId: address.id, profile: chosenProfile },
              own,
              now,
            )
          : null
        const deliveryFeeAmount = fare?.amount ?? delivery.deliveryFeeAmount

        // A code the customer supplied. A refusal does not fail the quote: a
        // basket that will not price because a code expired is a basket that
        // gets abandoned. The quote comes back undiscounted and says why.
        const promotion = input.promotionCode
          ? await reservePromotion(transaction, tenantId, customerId, {
              code: input.promotionCode,
              subtotal: subtotal.amount,
              // The charged fare, not the published rate: a percentage-off code
              // that ignored a rush uplift would discount a fee nobody was asked
              // to pay, and free-delivery codes would leave the uplift behind.
              deliveryFee: deliveryFeeAmount,
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
            deliveryFee: deliveryFeeAmount,
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
            deliveryFeeAmount,
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
            // Which of the three answers priced this, and why it moved. A fare a
            // customer disputes months from now has to be explainable: either a
            // marketplace quoted it and here is their reference, or it was the
            // breakfast rush and here is the multiplier.
            ...(fare && {
              deliveryFareSource: fare.source,
              deliveryFareMultiplierBasisPoints: fare.multiplierBasisPoints,
              deliveryFareReasonCodes: [...fare.reasonCodes],
              ...(fare.expiresAt && { deliveryFareExpiresAt: fare.expiresAt }),
              ...(fare.source === 'PROVIDER' && {
                deliveryFareProviderCode: fare.providerCode,
                deliveryFareProviderReference: fare.providerReference,
              }),
            }),
            deliveryVehicleProfile: chosenProfile,
            // The reason is recorded only when the car was required rather than
            // preferred. A customer who could have had a motorcycle and chose a
            // car has no reason to record, and writing one would claim their
            // order was too big or too far when it was neither.
            ...(chosenProfile === 'CAR' &&
              vehicle.reason !== 'NONE' && { deliveryVehicleReason: vehicle.reason }),
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
          ...mapQuote(quote, [...choice.options]),
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

/**
 * `vehicleOptions` is passed in rather than read off the quote, and only when a
 * quote is being created.
 *
 * They describe what was on offer at that moment, not a property of the quote —
 * the same reasoning the promotion refusal above is given. Re-reading an old
 * quote from the orders page should not be told which vehicles it could have
 * had, because the basket it was priced from is long gone and the answer would
 * be about nothing the customer can now act on.
 */
/**
 * The stored reason codes, in the words a customer reads.
 *
 * Translated here rather than stored in Persian, because the code is what the
 * quote is joined and reported on and the sentence is what changes when
 * somebody decides «شلوغی صبحگاهی» reads better another way. An unrecognised
 * code is dropped rather than shown raw: `MORNING_RUSH` on a checkout screen is
 * worse than no explanation at all.
 */
function fareReasonsFa(codes: readonly string[]): string[] {
  const sentences: Readonly<Record<string, string>> = {
    MORNING_RUSH: 'شلوغی صبحگاهی',
    EVENING_RUSH: 'شلوغی عصرگاهی',
    HIGH_DEMAND: 'تقاضای زیاد در این لحظه',
    PROVIDER_SURGE: 'افزایش نرخ سرویس ارسال',
  }
  return codes.map((code) => sentences[code]).filter((sentence): sentence is string => !!sentence)
}

function mapQuote(
  quote: QuoteRecord,
  vehicleOptions?: QuoteSummary['deliveryVehicleOptions'],
): QuoteSummary {
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
    ...(quote.deliveryVehicleProfile && {
      deliveryVehicleProfile: quote.deliveryVehicleProfile,
    }),
    ...(quote.deliveryVehicleReason && {
      deliveryVehicleReason: quote.deliveryVehicleReason as
        'LOAD' | 'DISTANCE' | 'LOAD_AND_DISTANCE',
    }),
    ...(vehicleOptions && { deliveryVehicleOptions: vehicleOptions }),
    deliveryPricingRuleId: quote.deliveryPricingRuleId,
    deliveryPricingRuleVersion: quote.deliveryPricingRuleVersion,
    subtotal: { amount: quote.subtotalAmount.toString(), currency: quote.currency },
    deliveryFee: { amount: quote.deliveryFeeAmount.toString(), currency: quote.currency },
    // Only when something actually moved the fare. A quote at the published
    // rate on an ordinary afternoon has nothing to explain, and a screen that
    // justifies a price nobody questioned invites the question.
    ...(quote.deliveryFareSource &&
      fareReasonsFa(quote.deliveryFareReasonCodes).length > 0 && {
        deliveryFareExplanation: {
          source: quote.deliveryFareSource,
          reasonsFa: fareReasonsFa(quote.deliveryFareReasonCodes),
          ...(quote.deliveryFareExpiresAt && {
            heldUntil: quote.deliveryFareExpiresAt.toISOString(),
          }),
        },
      }),
    discount: { amount: quote.discountAmount.toString(), currency: quote.currency },
    ...(quote.promotion && {
      promotion: {
        nameFa: quote.promotion.nameFa,
        basis: quote.promotionRedemption?.basis ?? 'SUBTOTAL',
      },
    }),
    paymentMethod: quote.paymentMethod,
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
        'DELIVERY_VEHICLE_TARIFF_MISSING',
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
    // Named separately from the line above because the remedy is different and
    // specific: the address and the basket are both fine, and what is missing
    // is a published car rate for this city. Refusing is deliberate — quoting
    // the motorcycle rate for a car journey loses the bakery money on exactly
    // its largest and longest orders, and does it silently until month end.
    DELIVERY_VEHICLE_TARIFF_MISSING:
      'This order needs a car, and no car delivery rate is published for this city yet.',
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
