import { DomainError } from './errors'

/**
 * What a discount code is worth, and whether it may be used at all.
 *
 * Discounts are the instrument a delivery business actually grows with, and in
 * this market they are how a new city is opened: a campaign scoped to one city,
 * running for a fixed window, capped so a mistake cannot cost more than it was
 * budgeted for. So a promotion here is not "ten percent off" — it is a set of
 * terms with a blast radius.
 *
 * Every rule in this module is arithmetic on integer Rial. There is no floating
 * point anywhere: a percentage is basis points and the multiplication happens in
 * bigint, because a discount that is a hundredth of a Rial out is a ledger that
 * does not balance, and it will not be noticed until someone reconciles a month.
 */

/** One percent, in basis points. Percentages are integers so they cannot drift. */
export const BASIS_POINTS_PER_PERCENT = 100
const BASIS_POINTS_TOTAL = 10_000

export const PromotionKind = {
  /** A share of the basket, in basis points, optionally capped. */
  PERCENTAGE: 'PERCENTAGE',
  /** A flat sum off the basket. */
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  /** The courier's fare, waived. */
  FREE_DELIVERY: 'FREE_DELIVERY',
} as const
export type PromotionKind = (typeof PromotionKind)[keyof typeof PromotionKind]

/**
 * What the discount comes off.
 *
 * Kept explicit rather than inferred, because the two are not interchangeable in
 * the ledger: money off the basket and a waived delivery fare are different
 * lines in the accounts and different conversations with a bakery partner.
 */
export const DiscountBasis = {
  SUBTOTAL: 'SUBTOTAL',
  DELIVERY_FEE: 'DELIVERY_FEE',
} as const
export type DiscountBasis = (typeof DiscountBasis)[keyof typeof DiscountBasis]

export interface PromotionTerms {
  readonly kind: PromotionKind
  /** Basis points off the subtotal. Required for PERCENTAGE, ignored otherwise. */
  readonly percentageBasisPoints?: number
  /** Rial off the subtotal. Required for FIXED_AMOUNT, ignored otherwise. */
  readonly fixedAmount?: bigint
  /** The most this promotion may ever be worth on one order. */
  readonly maxDiscountAmount?: bigint
  /** The basket must reach this before the code does anything. */
  readonly minSubtotalAmount?: bigint
  readonly startsAt: Date
  /** Null for a campaign with no end date. */
  readonly endsAt?: Date
  /** Across every customer. Null for uncapped. */
  readonly totalRedemptionLimit?: number
  /** Per customer. Null for uncapped. */
  readonly perCustomerLimit?: number
  /** Only for someone who has never completed an order. */
  readonly firstOrderOnly: boolean
  /**
   * The city this campaign belongs to, or null for every city.
   *
   * This is the field that makes provincial and national rollout possible: a
   * launch campaign for one city cannot be spent by customers in another, so
   * one budget cannot be drained by a market it was never meant for.
   */
  readonly cityId?: string
  readonly isActive: boolean
}

/** What is true about the customer and the campaign at the moment of asking. */
export interface PromotionContext {
  readonly subtotal: bigint
  readonly deliveryFee: bigint
  readonly cityId: string
  readonly now: Date
  /** How many times this promotion has been redeemed by anyone. */
  readonly totalRedemptions: number
  /** How many times by this customer. */
  readonly customerRedemptions: number
  /** Completed orders this customer already has. Zero makes them new. */
  readonly customerOrderCount: number
}

/**
 * Why a code did nothing.
 *
 * Each of these needs different words in front of a customer — "this ended", "add
 * more to your basket" and "you have used this already" are three different next
 * steps — so they stay separate rather than collapsing into one refusal.
 */
export const PromotionRefusal = {
  INACTIVE: 'PROMOTION_INACTIVE',
  NOT_STARTED: 'PROMOTION_NOT_STARTED',
  EXPIRED: 'PROMOTION_EXPIRED',
  WRONG_CITY: 'PROMOTION_WRONG_CITY',
  BELOW_MINIMUM: 'PROMOTION_BELOW_MINIMUM',
  EXHAUSTED: 'PROMOTION_EXHAUSTED',
  CUSTOMER_LIMIT_REACHED: 'PROMOTION_CUSTOMER_LIMIT_REACHED',
  NOT_FIRST_ORDER: 'PROMOTION_NOT_FIRST_ORDER',
  /** The terms are valid but worth nothing here — free delivery on a free delivery. */
  NO_EFFECT: 'PROMOTION_NO_EFFECT',
} as const
export type PromotionRefusal = (typeof PromotionRefusal)[keyof typeof PromotionRefusal]

export type PromotionOutcome =
  | {
      readonly applied: true
      readonly discountAmount: bigint
      readonly basis: DiscountBasis
    }
  | { readonly applied: false; readonly reason: PromotionRefusal }

/**
 * Checks the terms make sense before they are ever stored.
 *
 * A promotion with no percentage, or one over a hundred percent, is not a
 * campaign that behaves oddly — it is a campaign that pays customers to order.
 * Catching it here means it is refused when an operator creates it, in an
 * interface that can say why, rather than at the moment a stranger's basket is
 * being priced.
 */
export function validatePromotionTerms(terms: PromotionTerms): Readonly<PromotionTerms> {
  const issues: string[] = []

  if (terms.kind === PromotionKind.PERCENTAGE) {
    const bps = terms.percentageBasisPoints
    if (bps === undefined || !Number.isSafeInteger(bps)) {
      issues.push('A percentage promotion needs whole basis points')
    } else if (bps <= 0 || bps > BASIS_POINTS_TOTAL) {
      issues.push('A percentage must be above zero and at most one hundred percent')
    }
  }

  if (terms.kind === PromotionKind.FIXED_AMOUNT) {
    if (terms.fixedAmount === undefined || terms.fixedAmount <= 0n) {
      issues.push('A fixed promotion needs an amount above zero')
    }
  }

  if (terms.maxDiscountAmount !== undefined && terms.maxDiscountAmount <= 0n) {
    issues.push('A discount cap must be above zero')
  }
  if (terms.minSubtotalAmount !== undefined && terms.minSubtotalAmount < 0n) {
    issues.push('A minimum basket cannot be negative')
  }
  if (terms.endsAt && terms.endsAt <= terms.startsAt) {
    issues.push('A campaign cannot end before it starts')
  }
  for (const [name, limit] of [
    ['total', terms.totalRedemptionLimit],
    ['per-customer', terms.perCustomerLimit],
  ] as const) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      issues.push(`A ${name} redemption limit must be a whole number above zero`)
    }
  }

  if (issues.length > 0) {
    throw new DomainError('INVALID_PROMOTION_TERMS', 'Promotion terms are not usable', { issues })
  }
  return Object.freeze(terms)
}

/**
 * What this promotion is worth on this basket, right now.
 *
 * The eligibility checks run before the arithmetic and in a deliberate order:
 * the ones that are true of the campaign come first, then the ones that are true
 * of the customer, then the ones that depend on the basket. A customer whose
 * code expired last week should be told that, not told to spend more.
 */
export function evaluatePromotion(
  terms: PromotionTerms,
  context: PromotionContext,
): PromotionOutcome {
  const refusal = ineligibleReason(terms, context)
  if (refusal) return { applied: false, reason: refusal }

  const basis =
    terms.kind === PromotionKind.FREE_DELIVERY ? DiscountBasis.DELIVERY_FEE : DiscountBasis.SUBTOTAL
  const ceiling = basis === DiscountBasis.DELIVERY_FEE ? context.deliveryFee : context.subtotal

  let discount = rawDiscount(terms, context)
  if (terms.maxDiscountAmount !== undefined && discount > terms.maxDiscountAmount) {
    discount = terms.maxDiscountAmount
  }
  // A discount may never exceed what it comes off. Without this a 50,000 Rial
  // code on a 30,000 Rial basket would produce a negative total, and the first
  // thing that notices is the double-entry ledger refusing to balance.
  if (discount > ceiling) discount = ceiling

  if (discount <= 0n) return { applied: false, reason: PromotionRefusal.NO_EFFECT }
  return { applied: true, discountAmount: discount, basis }
}

function ineligibleReason(
  terms: PromotionTerms,
  context: PromotionContext,
): PromotionRefusal | null {
  if (!terms.isActive) return PromotionRefusal.INACTIVE
  if (context.now < terms.startsAt) return PromotionRefusal.NOT_STARTED
  if (terms.endsAt && context.now >= terms.endsAt) return PromotionRefusal.EXPIRED
  if (terms.cityId !== undefined && terms.cityId !== context.cityId) {
    return PromotionRefusal.WRONG_CITY
  }
  if (
    terms.totalRedemptionLimit !== undefined &&
    context.totalRedemptions >= terms.totalRedemptionLimit
  ) {
    return PromotionRefusal.EXHAUSTED
  }
  if (
    terms.perCustomerLimit !== undefined &&
    context.customerRedemptions >= terms.perCustomerLimit
  ) {
    return PromotionRefusal.CUSTOMER_LIMIT_REACHED
  }
  if (terms.firstOrderOnly && context.customerOrderCount > 0) {
    return PromotionRefusal.NOT_FIRST_ORDER
  }
  if (terms.minSubtotalAmount !== undefined && context.subtotal < terms.minSubtotalAmount) {
    return PromotionRefusal.BELOW_MINIMUM
  }
  return null
}

/**
 * The discount before caps.
 *
 * Percentages round down. There is nothing smaller than a Rial to carry the
 * remainder into, so the fraction has to go somewhere, and giving it to the shop
 * rather than the customer means a promotion can never cost a Rial more than its
 * stated percentage of a basket. The largest possible error is under one Rial —
 * far below the smallest coin anyone has ever held.
 */
function rawDiscount(terms: PromotionTerms, context: PromotionContext): bigint {
  switch (terms.kind) {
    case PromotionKind.PERCENTAGE:
      return (
        (context.subtotal * BigInt(terms.percentageBasisPoints ?? 0)) / BigInt(BASIS_POINTS_TOTAL)
      )
    case PromotionKind.FIXED_AMOUNT:
      return terms.fixedAmount ?? 0n
    case PromotionKind.FREE_DELIVERY:
      return context.deliveryFee
  }
}

/**
 * The order total once a discount has been applied.
 *
 * Written here rather than at each call site so that "what does the customer
 * pay" has exactly one answer. Delivery discounts and basket discounts reach the
 * same total by different routes, and a caller doing it by hand will eventually
 * subtract a delivery waiver from the subtotal.
 */
export function totalAfterDiscount(input: {
  subtotal: bigint
  deliveryFee: bigint
  discountAmount: bigint
}): bigint {
  const gross = input.subtotal + input.deliveryFee
  if (input.discountAmount > gross) {
    throw new DomainError('INVALID_PROMOTION_TERMS', 'A discount cannot exceed the order total')
  }
  return gross - input.discountAmount
}

/** Normalises a typed code: people type spaces, Persian digits and mixed case. */
export function normalizePromotionCode(raw: string): string {
  return raw
    .trim()
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\s‌-]+/g, '')
    .toUpperCase()
}
