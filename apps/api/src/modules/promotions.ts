import { randomUUID } from 'node:crypto'

import {
  PromotionRefusal,
  evaluatePromotion,
  normalizePromotionCode,
  type DiscountBasis,
  type PromotionOutcome,
  type PromotionTerms,
} from '@alo-noon/domain'
import type { Prisma } from '@alo-noon/database'

/**
 * Applying a discount code to a quote, and spending it when the order lands.
 *
 * The whole design turns on one distinction: a code is *reserved* when a quote
 * is cut and only *consumed* when an order is accepted. Without that, a campaign
 * capped at a thousand redemptions would be exhausted by a thousand people who
 * opened checkout and changed their minds, and the budget for opening a city
 * would be gone before anybody bought bread.
 *
 * Everything here runs inside the caller's transaction, which is SERIALIZABLE
 * for quote creation. That matters: two tabs racing the last redemption of a
 * campaign must not both win, and the limit is enforced by a conditional update
 * on a counter rather than by counting rows, because a count is a read that can
 * be stale by the time it is acted on.
 */

/** Anything the caller may hand back to a customer, in a code they can act on. */
export type PromotionApplication =
  | {
      readonly applied: true
      readonly promotionId: string
      readonly discountAmount: bigint
      readonly basis: DiscountBasis
      readonly nameFa: string
    }
  | { readonly applied: false; readonly reason: string }

type TransactionClient = Prisma.TransactionClient

function toTerms(row: {
  kind: string
  percentageBasisPoints: number | null
  fixedAmount: bigint | null
  maxDiscountAmount: bigint | null
  minSubtotalAmount: bigint | null
  startsAt: Date
  endsAt: Date | null
  totalRedemptionLimit: number | null
  perCustomerLimit: number | null
  firstOrderOnly: boolean
  cityId: string | null
  isActive: boolean
}): PromotionTerms {
  return {
    kind: row.kind as PromotionTerms['kind'],
    ...(row.percentageBasisPoints !== null && {
      percentageBasisPoints: row.percentageBasisPoints,
    }),
    ...(row.fixedAmount !== null && { fixedAmount: row.fixedAmount }),
    ...(row.maxDiscountAmount !== null && { maxDiscountAmount: row.maxDiscountAmount }),
    ...(row.minSubtotalAmount !== null && { minSubtotalAmount: row.minSubtotalAmount }),
    startsAt: row.startsAt,
    ...(row.endsAt !== null && { endsAt: row.endsAt }),
    ...(row.totalRedemptionLimit !== null && { totalRedemptionLimit: row.totalRedemptionLimit }),
    ...(row.perCustomerLimit !== null && { perCustomerLimit: row.perCustomerLimit }),
    firstOrderOnly: row.firstOrderOnly,
    ...(row.cityId !== null && { cityId: row.cityId }),
    isActive: row.isActive,
  }
}

/**
 * Prices a code against a basket without reserving anything.
 *
 * Used to answer "what would this be worth" while a customer is still typing,
 * so the shop can show the saving before they commit. It deliberately does not
 * hold a redemption: a preview that consumed budget would let anyone drain a
 * campaign by pasting a code repeatedly.
 */
export async function previewPromotion(
  transaction: TransactionClient,
  tenantId: string,
  customerId: string,
  input: { code: string; subtotal: bigint; deliveryFee: bigint; cityId: string; now: Date },
): Promise<PromotionApplication> {
  const found = await loadPromotion(transaction, tenantId, input.code)
  if (!found) return { applied: false, reason: 'PROMOTION_NOT_FOUND' }

  const outcome = await evaluate(transaction, tenantId, customerId, found, input)
  if (!outcome.applied) return { applied: false, reason: outcome.reason }
  return {
    applied: true,
    promotionId: found.id,
    discountAmount: outcome.discountAmount,
    basis: outcome.basis,
    nameFa: found.nameFa,
  }
}

/**
 * Prices a code and holds a redemption against it for one quote.
 *
 * The hold is what makes the limit meaningful. It is released when the quote is
 * superseded or expires, and turned into a spend when the order is accepted.
 */
export async function reservePromotion(
  transaction: TransactionClient,
  tenantId: string,
  customerId: string,
  input: {
    code: string
    subtotal: bigint
    deliveryFee: bigint
    cityId: string
    now: Date
    correlationId?: string
  },
): Promise<PromotionApplication & { redemptionId?: string }> {
  const found = await loadPromotion(transaction, tenantId, input.code)
  if (!found) return { applied: false, reason: 'PROMOTION_NOT_FOUND' }

  const outcome = await evaluate(transaction, tenantId, customerId, found, input)
  if (!outcome.applied) return { applied: false, reason: outcome.reason }

  // The budget is claimed with a conditional update, not a read-then-write. Two
  // customers racing the last redemption both pass the check above; only one of
  // them can win this.
  if (found.totalRedemptionLimit !== null) {
    const claimed = await transaction.$executeRaw`
      UPDATE "Promotion"
      SET "redeemedCount" = "redeemedCount" + 1, "updatedAt" = ${input.now}
      WHERE "id" = ${found.id}::uuid
        AND "tenantId" = ${tenantId}::uuid
        AND "redeemedCount" < ${found.totalRedemptionLimit}
    `
    if (claimed !== 1) return { applied: false, reason: PromotionRefusal.EXHAUSTED }
  } else {
    await transaction.$executeRaw`
      UPDATE "Promotion"
      SET "redeemedCount" = "redeemedCount" + 1, "updatedAt" = ${input.now}
      WHERE "id" = ${found.id}::uuid AND "tenantId" = ${tenantId}::uuid
    `
  }

  const redemption = await transaction.promotionRedemption.create({
    data: {
      tenantId,
      promotionId: found.id,
      customerId,
      amount: outcome.discountAmount,
      basis: outcome.basis,
      state: 'RESERVED',
      correlationId: input.correlationId ?? randomUUID(),
    },
    select: { id: true },
  })

  return {
    applied: true,
    promotionId: found.id,
    discountAmount: outcome.discountAmount,
    basis: outcome.basis,
    nameFa: found.nameFa,
    redemptionId: redemption.id,
  }
}

/** Ties a held redemption to the quote it priced. */
export async function attachRedemptionToQuote(
  transaction: TransactionClient,
  redemptionId: string,
  quoteId: string,
): Promise<void> {
  await transaction.promotionRedemption.update({
    where: { id: redemptionId },
    data: { quoteId },
  })
}

/**
 * Spends the hold, because the order was accepted.
 *
 * Only a RESERVED redemption may be consumed, and the database refuses any other
 * transition — so a replayed order cannot spend the same hold twice.
 */
export async function consumeRedemptionForQuote(
  transaction: TransactionClient,
  tenantId: string,
  quoteId: string,
  orderId: string,
): Promise<void> {
  await transaction.promotionRedemption.updateMany({
    where: { tenantId, quoteId, state: 'RESERVED' },
    data: { state: 'CONSUMED', orderId },
  })
}

/**
 * Gives the budget back, because the quote it was held for is dead.
 *
 * A superseded or expired quote must not keep a campaign's money tied up: the
 * customer who re-prices their basket is the same customer, and a hold that was
 * never released would let them exhaust their own per-customer limit by
 * changing their mind twice.
 */
export async function releaseRedemptionsForQuotes(
  transaction: TransactionClient,
  tenantId: string,
  quoteIds: readonly string[],
  now: Date,
): Promise<void> {
  if (quoteIds.length === 0) return
  const held = await transaction.promotionRedemption.findMany({
    where: { tenantId, quoteId: { in: [...quoteIds] }, state: 'RESERVED' },
    select: { id: true, promotionId: true },
  })
  if (held.length === 0) return

  await transaction.promotionRedemption.updateMany({
    where: { id: { in: held.map((entry) => entry.id) } },
    data: { state: 'RELEASED' },
  })

  // The counter comes back down with the holds. `GREATEST(…, 0)` because a
  // counter that went negative would silently grant extra budget, which is a
  // worse failure than one that under-counts.
  for (const entry of held) {
    await transaction.$executeRaw`
      UPDATE "Promotion"
      SET "redeemedCount" = GREATEST("redeemedCount" - 1, 0), "updatedAt" = ${now}
      WHERE "id" = ${entry.promotionId}::uuid AND "tenantId" = ${tenantId}::uuid
    `
  }
}

async function loadPromotion(
  transaction: TransactionClient,
  tenantId: string,
  code: string,
): Promise<
  | (Parameters<typeof toTerms>[0] & {
      id: string
      nameFa: string
      redeemedCount: number
    })
  | null
> {
  const normalized = normalizePromotionCode(code)
  if (!normalized) return null
  return transaction.promotion.findFirst({
    where: { tenantId, code: normalized },
    select: {
      id: true,
      nameFa: true,
      kind: true,
      percentageBasisPoints: true,
      fixedAmount: true,
      maxDiscountAmount: true,
      minSubtotalAmount: true,
      startsAt: true,
      endsAt: true,
      totalRedemptionLimit: true,
      perCustomerLimit: true,
      firstOrderOnly: true,
      cityId: true,
      isActive: true,
      redeemedCount: true,
    },
  })
}

async function evaluate(
  transaction: TransactionClient,
  tenantId: string,
  customerId: string,
  promotion: Parameters<typeof toTerms>[0] & { id: string; redeemedCount: number },
  input: { subtotal: bigint; deliveryFee: bigint; cityId: string; now: Date },
): Promise<PromotionOutcome> {
  // Only holds that are still alive or already spent count against a limit; a
  // released one gave its budget back.
  const [customerRedemptions, customerOrderCount] = await Promise.all([
    transaction.promotionRedemption.count({
      where: {
        tenantId,
        promotionId: promotion.id,
        customerId,
        state: { in: ['RESERVED', 'CONSUMED'] },
      },
    }),
    transaction.order.count({
      where: { tenantId, customerId, state: { notIn: ['DRAFT', 'CANCELLED'] } },
    }),
  ])

  return evaluatePromotion(toTerms(promotion), {
    subtotal: input.subtotal,
    deliveryFee: input.deliveryFee,
    cityId: input.cityId,
    now: input.now,
    totalRedemptions: promotion.redeemedCount,
    customerRedemptions,
    customerOrderCount,
  })
}
