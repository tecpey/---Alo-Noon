import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  DiscountBasis,
  PromotionKind,
  PromotionRefusal,
  evaluatePromotion,
  promotionRefusalMessage,
  normalizePromotionCode,
  totalAfterDiscount,
  validatePromotionTerms,
  type PromotionContext,
  type PromotionTerms,
} from './promotion'

const CITY = '11111111-1111-4111-8111-111111111111'
const OTHER_CITY = '22222222-2222-4222-8222-222222222222'

function terms(overrides: Partial<PromotionTerms> = {}): PromotionTerms {
  return {
    kind: PromotionKind.PERCENTAGE,
    percentageBasisPoints: 1_000, // ten percent
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    firstOrderOnly: false,
    isActive: true,
    ...overrides,
  }
}

function context(overrides: Partial<PromotionContext> = {}): PromotionContext {
  return {
    subtotal: 100_000n,
    deliveryFee: 50_000n,
    cityId: CITY,
    now: new Date('2026-06-01T12:00:00.000Z'),
    totalRedemptions: 0,
    customerRedemptions: 0,
    customerOrderCount: 0,
    ...overrides,
  }
}

describe('evaluatePromotion — what a code is worth', () => {
  it('takes a percentage of the basket, not of the delivery fee', () => {
    const result = evaluatePromotion(terms(), context())
    expect(result).toEqual({
      applied: true,
      discountAmount: 10_000n,
      basis: DiscountBasis.SUBTOTAL,
    })
  })

  it('takes a fixed amount off the basket', () => {
    const result = evaluatePromotion(
      terms({ kind: PromotionKind.FIXED_AMOUNT, fixedAmount: 25_000n }),
      context(),
    )
    expect(result).toEqual({
      applied: true,
      discountAmount: 25_000n,
      basis: DiscountBasis.SUBTOTAL,
    })
  })

  it('waives the fare, and says that is what it did', () => {
    const result = evaluatePromotion(terms({ kind: PromotionKind.FREE_DELIVERY }), context())
    expect(result).toEqual({
      applied: true,
      discountAmount: 50_000n,
      basis: DiscountBasis.DELIVERY_FEE,
    })
  })

  /**
   * Rounding down is the whole reason percentages are basis points. A campaign
   * advertised as ten percent must never cost more than ten percent, and there
   * is nothing smaller than a Rial for the remainder to live in.
   */
  it('rounds a percentage down, never up', () => {
    // 7% of 99,999 is 6,999.93.
    const result = evaluatePromotion(
      terms({ percentageBasisPoints: 700 }),
      context({ subtotal: 99_999n }),
    )
    expect(result).toEqual({
      applied: true,
      discountAmount: 6_999n,
      basis: DiscountBasis.SUBTOTAL,
    })
  })

  it('caps a percentage at the campaign ceiling', () => {
    const result = evaluatePromotion(
      terms({ percentageBasisPoints: 5_000, maxDiscountAmount: 30_000n }),
      context({ subtotal: 1_000_000n }),
    )
    expect(result).toEqual({
      applied: true,
      discountAmount: 30_000n,
      basis: DiscountBasis.SUBTOTAL,
    })
  })

  /**
   * The invariant the ledger depends on. A 50,000 code on a 30,000 basket must
   * not produce a negative total — the double-entry books would refuse to
   * balance, and the failure would surface far from its cause.
   */
  it('never discounts more than the thing it comes off', () => {
    const result = evaluatePromotion(
      terms({ kind: PromotionKind.FIXED_AMOUNT, fixedAmount: 500_000n }),
      context({ subtotal: 30_000n }),
    )
    expect(result).toEqual({
      applied: true,
      discountAmount: 30_000n,
      basis: DiscountBasis.SUBTOTAL,
    })
  })

  it('is worth nothing when the fare is already free', () => {
    const result = evaluatePromotion(
      terms({ kind: PromotionKind.FREE_DELIVERY }),
      context({ deliveryFee: 0n }),
    )
    expect(result).toEqual({ applied: false, reason: PromotionRefusal.NO_EFFECT })
  })

  it('is worth nothing on an empty basket', () => {
    const result = evaluatePromotion(terms(), context({ subtotal: 0n }))
    expect(result).toEqual({ applied: false, reason: PromotionRefusal.NO_EFFECT })
  })
})

describe('evaluatePromotion — who may use it', () => {
  it('refuses a campaign that has been switched off', () => {
    expect(evaluatePromotion(terms({ isActive: false }), context())).toEqual({
      applied: false,
      reason: PromotionRefusal.INACTIVE,
    })
  })

  it('refuses before it starts and after it ends', () => {
    const window = terms({
      startsAt: new Date('2026-06-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    expect(
      evaluatePromotion(window, context({ now: new Date('2026-05-31T23:59:59.000Z') })),
    ).toEqual({ applied: false, reason: PromotionRefusal.NOT_STARTED })
    expect(
      evaluatePromotion(window, context({ now: new Date('2026-07-01T00:00:00.000Z') })),
    ).toEqual({ applied: false, reason: PromotionRefusal.EXPIRED })
    // The end is exclusive, so the last instant before it still works.
    expect(
      evaluatePromotion(window, context({ now: new Date('2026-06-30T23:59:59.000Z') })).applied,
    ).toBe(true)
  })

  /**
   * The lever the whole provincial rollout rests on: a budget for opening one
   * city cannot be spent by customers in another.
   */
  it('keeps a city campaign inside its city', () => {
    const campaign = terms({ cityId: CITY })
    expect(evaluatePromotion(campaign, context({ cityId: OTHER_CITY }))).toEqual({
      applied: false,
      reason: PromotionRefusal.WRONG_CITY,
    })
    expect(evaluatePromotion(campaign, context({ cityId: CITY })).applied).toBe(true)
  })

  it('lets a national campaign run everywhere', () => {
    expect(evaluatePromotion(terms(), context({ cityId: OTHER_CITY })).applied).toBe(true)
  })

  it('stops when the campaign is spent', () => {
    const campaign = terms({ totalRedemptionLimit: 500 })
    expect(evaluatePromotion(campaign, context({ totalRedemptions: 500 }))).toEqual({
      applied: false,
      reason: PromotionRefusal.EXHAUSTED,
    })
    expect(evaluatePromotion(campaign, context({ totalRedemptions: 499 })).applied).toBe(true)
  })

  it('stops when one customer has had their share', () => {
    const campaign = terms({ perCustomerLimit: 1 })
    expect(evaluatePromotion(campaign, context({ customerRedemptions: 1 }))).toEqual({
      applied: false,
      reason: PromotionRefusal.CUSTOMER_LIMIT_REACHED,
    })
  })

  it('keeps a welcome code for people who have never ordered', () => {
    const welcome = terms({ firstOrderOnly: true })
    expect(evaluatePromotion(welcome, context({ customerOrderCount: 1 }))).toEqual({
      applied: false,
      reason: PromotionRefusal.NOT_FIRST_ORDER,
    })
    expect(evaluatePromotion(welcome, context({ customerOrderCount: 0 })).applied).toBe(true)
  })

  it('asks for a bigger basket when the minimum is not met', () => {
    const campaign = terms({ minSubtotalAmount: 200_000n })
    expect(evaluatePromotion(campaign, context({ subtotal: 199_999n }))).toEqual({
      applied: false,
      reason: PromotionRefusal.BELOW_MINIMUM,
    })
    expect(evaluatePromotion(campaign, context({ subtotal: 200_000n })).applied).toBe(true)
  })

  /**
   * A customer whose code expired last week should be told that, not told to
   * spend more money — so the order the reasons are checked in is itself a
   * behaviour worth pinning.
   */
  it('reports the campaign being over before it reports a small basket', () => {
    const both = terms({
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      minSubtotalAmount: 900_000n,
    })
    expect(evaluatePromotion(both, context({ subtotal: 1_000n }))).toEqual({
      applied: false,
      reason: PromotionRefusal.EXPIRED,
    })
  })
})

describe('validatePromotionTerms', () => {
  it('accepts terms that make sense', () => {
    expect(validatePromotionTerms(terms())).toBeDefined()
  })

  it('refuses a percentage that would pay the customer to order', () => {
    expect(() => validatePromotionTerms(terms({ percentageBasisPoints: 10_001 }))).toThrow(
      DomainError,
    )
    expect(() => validatePromotionTerms(terms({ percentageBasisPoints: 0 }))).toThrow(DomainError)
    expect(() => validatePromotionTerms(terms({ percentageBasisPoints: 12.5 }))).toThrow(
      DomainError,
    )
  })

  it('refuses a percentage promotion with no percentage', () => {
    const withoutPercentage = { ...terms() }
    delete (withoutPercentage as { percentageBasisPoints?: number }).percentageBasisPoints
    expect(() => validatePromotionTerms(withoutPercentage)).toThrow(DomainError)
  })

  it('refuses a fixed promotion worth nothing', () => {
    expect(() =>
      validatePromotionTerms(terms({ kind: PromotionKind.FIXED_AMOUNT, fixedAmount: 0n })),
    ).toThrow(DomainError)
  })

  it('refuses a campaign that ends before it starts', () => {
    expect(() =>
      validatePromotionTerms(
        terms({
          startsAt: new Date('2026-06-01T00:00:00.000Z'),
          endsAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ),
    ).toThrow(DomainError)
  })

  it('refuses a limit that is not a whole number above zero', () => {
    expect(() => validatePromotionTerms(terms({ totalRedemptionLimit: 0 }))).toThrow(DomainError)
    expect(() => validatePromotionTerms(terms({ perCustomerLimit: -1 }))).toThrow(DomainError)
  })

  it('accepts a hundred percent, which is a giveaway and still legitimate', () => {
    expect(validatePromotionTerms(terms({ percentageBasisPoints: 10_000 }))).toBeDefined()
  })
})

describe('totalAfterDiscount', () => {
  it('subtracts a basket discount from the gross', () => {
    expect(
      totalAfterDiscount({ subtotal: 100_000n, deliveryFee: 50_000n, discountAmount: 10_000n }),
    ).toBe(140_000n)
  })

  it('reaches the same total for a waived fare', () => {
    expect(
      totalAfterDiscount({ subtotal: 100_000n, deliveryFee: 50_000n, discountAmount: 50_000n }),
    ).toBe(100_000n)
  })

  it('refuses to produce a negative total', () => {
    expect(() =>
      totalAfterDiscount({ subtotal: 10_000n, deliveryFee: 5_000n, discountAmount: 20_000n }),
    ).toThrow(DomainError)
  })
})

describe('normalizePromotionCode', () => {
  it('accepts the code as a person actually types it', () => {
    expect(normalizePromotionCode('  noon10 ')).toBe('NOON10')
    expect(normalizePromotionCode('NOON 10')).toBe('NOON10')
    expect(normalizePromotionCode('noon-10')).toBe('NOON10')
  })

  /** A Persian keyboard produces Persian digits, and they are the same code. */
  it('reads Persian and Arabic digits as the digits they are', () => {
    expect(normalizePromotionCode('نان۱۰')).toBe('نان10')
    expect(normalizePromotionCode('NOON١٠')).toBe('NOON10')
  })

  it('strips the zero-width joiner a Persian keyboard inserts', () => {
    expect(normalizePromotionCode('NOON‌10')).toBe('NOON10')
  })
})

describe('promotionRefusalMessage', () => {
  /**
   * Every refusal above exists because it needs different words. A code added
   * to the enumeration without a sentence here reaches the customer as
   * «این کد اعمال نشد» — technically true, and no help to somebody whose
   * basket is four hundred tomans short of the minimum.
   */
  it('answers every refusal the domain can produce', () => {
    for (const reason of Object.values(PromotionRefusal)) {
      expect(promotionRefusalMessage(reason)).toBeTruthy()
    }
  })

  it('gives each refusal its own answer', () => {
    const messages = Object.values(PromotionRefusal).map(promotionRefusalMessage)
    expect(new Set(messages).size).toBe(messages.length)
  })

  /** Not a refusal the domain evaluates, but the one customers hit by mistyping. */
  it('answers a code that does not exist', () => {
    expect(promotionRefusalMessage('PROMOTION_NOT_FOUND')).toBe('این کد تخفیف وجود ندارد.')
  })

  /**
   * Undefined rather than a sentence, so the caller's own fallback wins: the
   * web appends the raw code for an operator, which is more use during
   * provisioning than a polite line that hides which invariant tripped.
   */
  it('defers to the caller on a code it does not know', () => {
    expect(promotionRefusalMessage('SOMETHING_ELSE')).toBeUndefined()
  })
})
