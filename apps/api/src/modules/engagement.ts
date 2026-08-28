import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  assessBranchQuality,
  checkOrderRating,
  planReorder,
  type BranchQualitySignal,
  type OrderRatingInput,
  type QualityPolicy,
  type ReorderDrop,
} from '@alo-noon/domain'

/**
 * Coming back.
 *
 * Reordering is the whole point of this module and the reason it exists at all:
 * bread is bought again, most mornings, and usually the same two or three
 * loaves. Every tap between a customer and yesterday's basket is a tap that
 * loses one.
 *
 * Ratings and favourites are here because they serve the same end. A favourite
 * is how somebody says "this is my bread" before they have a history to repeat;
 * a rating is how the platform learns which bakery to send them back to, and
 * how a partner whose bread has gone wrong gets looked at before the complaints
 * arrive rather than after.
 */

export class EngagementError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'EngagementError'
  }
}

/**
 * When a branch's ratings start to mean something.
 *
 * Ten ratings and an average at or below three. Both halves matter: the
 * threshold is what "bad" means, and the sample size is what stops a partner
 * losing their standing to one bad morning and two strangers.
 */
export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  minimumSampleSize: 10,
  flagBelowHundredths: 300,
}

/**
 * How far back a branch's quality is read.
 *
 * A bakery that was poor in the spring and has since changed its flour should
 * not be judged on the spring. Ninety days is long enough to be a pattern and
 * short enough to be the present.
 */
const QUALITY_WINDOW_DAYS = 90
const MILLISECONDS_PER_DAY = 86_400_000

export interface RatingSummary {
  readonly orderId: string
  readonly breadScore: number
  readonly deliveryScore: number | null
  readonly comment: string | null
  readonly createdAt: string
}

export interface ReorderOutcome {
  readonly cartId: string
  readonly addedCount: number
  readonly adjustments: readonly {
    offeringId: string
    nameFa: string
    reason: ReorderDrop
    quantity: number
  }[]
}

export interface FavouriteSummary {
  readonly offeringId: string
  readonly productVariantId: string
  readonly nameFa: string
  readonly slug: string
  readonly priceAmount: string
  readonly available: boolean
}

export interface EngagementService {
  /** Records what a customer thought of their own order. */
  rateOrder(
    tenantId: string,
    customerId: string,
    orderId: string,
    input: OrderRatingInput,
    now: Date,
    correlationId: string,
  ): Promise<RatingSummary>
  /** The customer's own rating for an order, if they left one. */
  findRating(tenantId: string, customerId: string, orderId: string): Promise<RatingSummary | null>
  /** How a branch is doing, over the recent window. */
  branchQuality(
    tenantId: string,
    bakeryBranchId: string,
    now: Date,
    policy?: QualityPolicy,
  ): Promise<BranchQualitySignal>
  /** Rebuilds a basket from a past order, at today's prices. */
  reorder(
    tenantId: string,
    customerId: string,
    orderId: string,
    now: Date,
    correlationId: string,
  ): Promise<ReorderOutcome>
  listFavourites(tenantId: string, customerId: string): Promise<readonly FavouriteSummary[]>
  addFavourite(tenantId: string, customerId: string, offeringId: string): Promise<void>
  removeFavourite(tenantId: string, customerId: string, offeringId: string): Promise<void>
}

export function createPrismaEngagementService(prisma: PrismaClient): EngagementService {
  return {
    async rateOrder(tenantId, customerId, orderId, input, now, correlationId) {
      return serializable(prisma, tenantId, async (transaction) => {
        // ownership-established: scoped to the session's own customerId, so
        // another customer's order reads as absent rather than as a refusal
        // that confirms it exists.
        const order = await transaction.order.findFirst({
          where: { id: orderId, tenantId, customerId },
          select: {
            id: true,
            state: true,
            bakeryBranchId: true,
            rating: { select: { id: true } },
            // When it actually arrived. Read from the transition that completed
            // the order rather than from a timestamp on the row: `updatedAt`
            // moves every time anything about the order is touched, and a
            // rating window measured from it would reopen itself.
            transitions: {
              where: { toState: 'COMPLETED' },
              orderBy: { occurredAt: 'desc' },
              take: 1,
              select: { occurredAt: true },
            },
          },
        })
        if (!order) throw new EngagementError('ORDER_NOT_FOUND', 404)

        const refusal = checkOrderRating(input, {
          orderState: order.state,
          deliveredAt: order.transitions[0]?.occurredAt ?? null,
          now,
          alreadyRated: order.rating !== null,
        })
        if (refusal) throw new EngagementError(refusal, 422)

        const rating = await transaction.orderRating.create({
          data: {
            tenantId,
            orderId: order.id,
            customerId,
            breadScore: input.breadScore,
            ...(input.deliveryScore !== undefined && { deliveryScore: input.deliveryScore }),
            ...(input.comment !== undefined && { comment: input.comment.trim() || null }),
          },
        })

        // The engagement stream, on a transactional basis: this is the
        // customer's own statement about their own order, not something
        // observed about them.
        await transaction.customerEvent.create({
          data: {
            tenantId,
            eventId: rating.id,
            customerId,
            name: 'order.rated',
            purpose: 'ENGAGEMENT',
            consentBasis: 'TRANSACTIONAL',
            subjectType: 'order',
            subjectId: order.id,
            correlationId,
            properties: {
              breadScore: input.breadScore,
              deliveryScore: input.deliveryScore ?? null,
              bakeryBranchId: order.bakeryBranchId,
            },
            occurredAt: now,
          },
        })

        return mapRating(rating)
      })
    },

    async findRating(tenantId, customerId, orderId) {
      return readCommitted(prisma, tenantId, async (transaction) => {
        // ownership-established: filtered on the session's own customerId.
        const rating = await transaction.orderRating.findFirst({
          where: { tenantId, orderId, customerId },
        })
        return rating ? mapRating(rating) : null
      })
    },

    async branchQuality(tenantId, bakeryBranchId, now, policy = DEFAULT_QUALITY_POLICY) {
      return readCommitted(prisma, tenantId, async (transaction) => {
        // ownership-established: an aggregate over a branch's ratings, not one
        // customer's. There is no customer to scope to and none is exposed —
        // only the scores are read.
        const ratings = await transaction.orderRating.findMany({
          where: {
            tenantId,
            createdAt: {
              gte: new Date(now.getTime() - QUALITY_WINDOW_DAYS * MILLISECONDS_PER_DAY),
            },
            order: { bakeryBranchId },
          },
          select: { breadScore: true },
        })
        return assessBranchQuality(
          ratings.map((rating) => rating.breadScore),
          policy,
        )
      })
    },

    async reorder(tenantId, customerId, orderId, now, correlationId) {
      return serializable(prisma, tenantId, async (transaction) => {
        // ownership-established: scoped to the session's own customerId.
        const order = await transaction.order.findFirst({
          where: { id: orderId, tenantId, customerId, state: { not: 'DRAFT' } },
          select: {
            id: true,
            cityId: true,
            operationalZoneId: true,
            bakeryBranchId: true,
            items: {
              select: { bakeryProductOfferingId: true, quantity: true },
              orderBy: { id: 'asc' },
            },
          },
        })
        if (!order) throw new EngagementError('ORDER_NOT_FOUND', 404)
        if (order.items.length === 0) throw new EngagementError('REORDER_EMPTY', 422)

        const offerings = await transaction.bakeryProductOffering.findMany({
          where: {
            tenantId,
            id: { in: order.items.map((item) => item.bakeryProductOfferingId) },
          },
          select: {
            id: true,
            availability: true,
            availableFrom: true,
            availableUntil: true,
            priceAmount: true,
            dailyCapacity: true,
            stockTracked: true,
            stockOnHand: true,
            bakeryBranchId: true,
            bakeryBranch: { select: { operationalStatus: true, qualityStatus: true } },
            productVariant: {
              select: { nameFa: true, lifecycle: true, product: { select: { lifecycle: true } } },
            },
          },
        })
        const byId = new Map(offerings.map((offering) => [offering.id, offering]))

        // Prices are read fresh above and never copied from the order. A basket
        // rebuilt at three-week-old prices sells bread below what it costs to
        // bake, and a customer quietly charged yesterday's price has a receipt
        // that matches nothing.
        const plan = planReorder(
          order.items.map((item) => ({
            offeringId: item.bakeryProductOfferingId,
            quantity: item.quantity,
          })),
          offerings.map((offering) => ({
            offeringId: offering.id,
            orderable: orderable(offering, now),
            unitPriceAmount: offering.priceAmount,
            maximumQuantity: quantityCeiling(offering),
          })),
        )
        if (plan.lines.length === 0) throw new EngagementError('REORDER_NOTHING_AVAILABLE', 422)

        // A reorder replaces the basket rather than adding to it. "Order again"
        // means yesterday's order, and quietly merging it into whatever was
        // already there produces a basket the customer never chose.
        const existing = await transaction.cart.findFirst({
          where: { tenantId, customerId, state: 'ACTIVE' },
          select: { id: true, version: true },
        })
        let cartId: string
        if (existing) {
          // ownership-established: the cart was loaded above under customerId.
          await transaction.cartItem.deleteMany({ where: { cartId: existing.id } })
          // ownership-established: same cart, loaded above under customerId.
          await transaction.cart.updateMany({
            where: { id: existing.id, state: 'ACTIVE' },
            data: {
              version: { increment: 1 },
              cityId: order.cityId,
              operationalZoneId: order.operationalZoneId,
              bakeryBranchId: order.bakeryBranchId,
            },
          })
          cartId = existing.id
        } else {
          const created = await transaction.cart.create({
            data: {
              tenantId,
              customerId,
              cityId: order.cityId,
              operationalZoneId: order.operationalZoneId,
              bakeryBranchId: order.bakeryBranchId,
            },
            select: { id: true },
          })
          cartId = created.id
        }

        await transaction.cartItem.createMany({
          data: plan.lines.map((line) => ({
            tenantId,
            cartId,
            bakeryProductOfferingId: line.offeringId,
            quantity: line.quantity,
          })),
        })
        // Any quote against the old basket is about a different basket now.
        // ownership-established: the cart resolved above under customerId.
        await transaction.quote.updateMany({
          where: { cartId, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED', expiresAt: now },
        })

        await transaction.customerEvent.create({
          data: {
            tenantId,
            eventId: randomEventId(),
            customerId,
            name: 'order.reordered',
            purpose: 'ENGAGEMENT',
            consentBasis: 'TRANSACTIONAL',
            subjectType: 'order',
            subjectId: order.id,
            correlationId,
            properties: {
              lineCount: plan.lines.length,
              adjustmentCount: plan.adjustments.length,
            },
            occurredAt: now,
          },
        })

        return {
          cartId,
          addedCount: plan.lines.length,
          adjustments: plan.adjustments.map((adjustment) => ({
            offeringId: adjustment.offeringId,
            // Named, not just identified. "One item is unavailable" tells a
            // customer nothing they can act on; "کنجدی موجود نیست" does.
            nameFa: byId.get(adjustment.offeringId)?.productVariant.nameFa ?? 'یک قلم',
            reason: adjustment.reason,
            quantity: adjustment.quantity,
          })),
        }
      })
    },

    async listFavourites(tenantId, customerId) {
      return readCommitted(prisma, tenantId, async (transaction) => {
        // ownership-established: filtered on the session's own customerId.
        const favourites = await transaction.customerFavourite.findMany({
          where: { tenantId, customerId },
          orderBy: { createdAt: 'desc' },
          select: {
            bakeryProductOffering: {
              select: {
                id: true,
                availability: true,
                availableFrom: true,
                availableUntil: true,
                priceAmount: true,
                dailyCapacity: true,
                stockTracked: true,
                stockOnHand: true,
                bakeryBranch: { select: { operationalStatus: true, qualityStatus: true } },
                productVariant: {
                  select: {
                    id: true,
                    nameFa: true,
                    lifecycle: true,
                    product: { select: { slug: true, lifecycle: true } },
                  },
                },
              },
            },
          },
        })
        const now = new Date()
        return favourites.map(({ bakeryProductOffering: offering }) => ({
          offeringId: offering.id,
          productVariantId: offering.productVariant.id,
          nameFa: offering.productVariant.nameFa,
          slug: offering.productVariant.product.slug,
          priceAmount: offering.priceAmount.toString(),
          // Reported rather than filtered out. A favourite that has sold out is
          // still the customer's favourite, and removing it from the list would
          // look like the platform lost it.
          available: orderable(offering, now),
        }))
      })
    },

    async addFavourite(tenantId, customerId, offeringId) {
      await readCommitted(prisma, tenantId, async (transaction) => {
        const offering = await transaction.bakeryProductOffering.findFirst({
          where: { id: offeringId, tenantId },
          select: { id: true },
        })
        if (!offering) throw new EngagementError('OFFERING_NOT_FOUND', 404)
        // A second tap is the same favourite, not an error and not a duplicate.
        await transaction.customerFavourite.upsert({
          where: {
            tenantId_customerId_bakeryProductOfferingId: {
              tenantId,
              customerId,
              bakeryProductOfferingId: offeringId,
            },
          },
          create: { tenantId, customerId, bakeryProductOfferingId: offeringId },
          update: {},
        })
      })
    },

    async removeFavourite(tenantId, customerId, offeringId) {
      await readCommitted(prisma, tenantId, async (transaction) => {
        // ownership-established: deletes only the session customer's own row.
        await transaction.customerFavourite.deleteMany({
          where: { tenantId, customerId, bakeryProductOfferingId: offeringId },
        })
      })
    },
  }
}

/** Everything that has to be true before a loaf can go back in a basket. */
function orderable(
  offering: {
    availability: string
    availableFrom: Date | null
    availableUntil: Date | null
    dailyCapacity: number | null
    stockTracked: boolean
    stockOnHand: number | null
    bakeryBranch: { operationalStatus: string; qualityStatus: string }
    productVariant: { lifecycle: string; product: { lifecycle: string } }
  },
  now: Date,
): boolean {
  return (
    offering.availability === 'AVAILABLE' &&
    offering.bakeryBranch.operationalStatus === 'ACTIVE' &&
    offering.bakeryBranch.qualityStatus === 'APPROVED' &&
    offering.productVariant.lifecycle === 'ACTIVE' &&
    offering.productVariant.product.lifecycle === 'ACTIVE' &&
    (!offering.availableFrom || offering.availableFrom <= now) &&
    (!offering.availableUntil || offering.availableUntil > now) &&
    offering.dailyCapacity !== 0 &&
    (!offering.stockTracked || (offering.stockOnHand ?? 0) > 0)
  )
}

/**
 * The most of this loaf a basket may hold today.
 *
 * The tighter of what the branch bakes and what is actually left on the shelf.
 * Null when neither is capped.
 */
function quantityCeiling(offering: {
  dailyCapacity: number | null
  stockTracked: boolean
  stockOnHand: number | null
}): number | null {
  const caps: number[] = []
  if (offering.dailyCapacity !== null) caps.push(offering.dailyCapacity)
  if (offering.stockTracked) caps.push(offering.stockOnHand ?? 0)
  return caps.length === 0 ? null : Math.min(...caps)
}

function mapRating(rating: {
  orderId: string
  breadScore: number
  deliveryScore: number | null
  comment: string | null
  createdAt: Date
}): RatingSummary {
  return {
    orderId: rating.orderId,
    breadScore: rating.breadScore,
    deliveryScore: rating.deliveryScore,
    comment: rating.comment,
    createdAt: rating.createdAt.toISOString(),
  }
}

function randomEventId(): string {
  return crypto.randomUUID()
}

async function serializable<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'Serializable' },
  )
}

async function readCommitted<T>(
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
