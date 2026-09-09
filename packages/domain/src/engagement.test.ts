import { describe, expect, it } from 'vitest'

import {
  RATING_MAX_COMMENT,
  RatingRefusal,
  ReorderDrop,
  assessBranchQuality,
  checkOrderRating,
  summariseBranchQuality,
  planReorder,
  type OrderRatingContext,
  type OrderRatingInput,
  type QualityPolicy,
  type ReorderAvailability,
} from './engagement'
import { DomainError } from './errors'

const now = new Date('2026-08-20T09:00:00.000Z')

function context(overrides: Partial<OrderRatingContext> = {}): OrderRatingContext {
  return {
    orderState: 'COMPLETED',
    deliveredAt: new Date('2026-08-19T07:00:00.000Z'),
    now,
    alreadyRated: false,
    ...overrides,
  }
}

function rating(overrides: Partial<OrderRatingInput> = {}): OrderRatingInput {
  return { breadScore: 5, ...overrides }
}

describe('checkOrderRating', () => {
  it('accepts a rating on a delivered order', () => {
    expect(checkOrderRating(rating(), context())).toBeNull()
  })

  it('accepts a delivery score alongside the bread', () => {
    expect(checkOrderRating(rating({ deliveryScore: 3 }), context())).toBeNull()
  })

  /** An order still in an oven has nothing to say about. */
  it('refuses an order that has not arrived', () => {
    expect(checkOrderRating(rating(), context({ orderState: 'IN_FULFILLMENT' }))).toBe(
      RatingRefusal.NOT_DELIVERED,
    )
    expect(checkOrderRating(rating(), context({ deliveredAt: null }))).toBe(
      RatingRefusal.NOT_DELIVERED,
    )
  })

  it('refuses a second rating on the same order', () => {
    expect(checkOrderRating(rating(), context({ alreadyRated: true }))).toBe(
      RatingRefusal.ALREADY_RATED,
    )
  })

  /**
   * Past a month it is a mood rather than a memory, and letting it in would
   * let somebody relitigate an old order every time a new one annoyed them.
   */
  it('closes the window after a month', () => {
    expect(
      checkOrderRating(rating(), context({ deliveredAt: new Date('2026-07-20T08:00:00.000Z') })),
    ).toBe(RatingRefusal.WINDOW_CLOSED)
    // A day inside it still counts.
    expect(
      checkOrderRating(rating(), context({ deliveredAt: new Date('2026-07-21T09:00:00.000Z') })),
    ).toBeNull()
  })

  it('refuses a score outside one to five', () => {
    expect(checkOrderRating(rating({ breadScore: 0 }), context())).toBe(RatingRefusal.INVALID_SCORE)
    expect(checkOrderRating(rating({ breadScore: 6 }), context())).toBe(RatingRefusal.INVALID_SCORE)
    expect(checkOrderRating(rating({ breadScore: 4.5 }), context())).toBe(
      RatingRefusal.INVALID_SCORE,
    )
    expect(checkOrderRating(rating({ deliveryScore: 9 }), context())).toBe(
      RatingRefusal.INVALID_SCORE,
    )
  })

  it('refuses a comment longer than it needs to be', () => {
    expect(
      checkOrderRating(rating({ comment: 'ب'.repeat(RATING_MAX_COMMENT) }), context()),
    ).toBeNull()
    expect(
      checkOrderRating(rating({ comment: 'ب'.repeat(RATING_MAX_COMMENT + 1) }), context()),
    ).toBe(RatingRefusal.COMMENT_TOO_LONG)
  })

  /**
   * Somebody rating a month-old order should be told the window closed, not
   * that their score is out of range — the two send them to different places.
   */
  it('reports the closed window before it reports the score', () => {
    expect(
      checkOrderRating(
        rating({ breadScore: 99 }),
        context({ deliveredAt: new Date('2026-01-01T00:00:00.000Z') }),
      ),
    ).toBe(RatingRefusal.WINDOW_CLOSED)
  })
})

describe('assessBranchQuality', () => {
  const policy: QualityPolicy = { minimumSampleSize: 10, flagBelowHundredths: 300 }

  it('reports nothing for a branch nobody has rated', () => {
    expect(assessBranchQuality([], policy)).toEqual({
      sampleSize: 0,
      averageHundredths: 0,
      flagForReview: false,
    })
  })

  it('averages in hundredths', () => {
    expect(assessBranchQuality([4, 5, 4, 4], policy).averageHundredths).toBe(425)
  })

  /** Rounded, not truncated: this reads the scores, it does not spend money. */
  it('rounds the average rather than dropping the remainder', () => {
    // 4 + 4 + 5 = 13 over 3 is 4.333…
    expect(assessBranchQuality([4, 4, 5], policy).averageHundredths).toBe(433)
    // 3 + 4 = 7 over 2 is exactly 3.5.
    expect(assessBranchQuality([3, 4], policy).averageHundredths).toBe(350)
  })

  /**
   * A bakery is not judged on three opinions. The alternative is a partner
   * losing their livelihood to one bad morning and two strangers.
   */
  it('will not flag a branch on too few ratings', () => {
    const awful = assessBranchQuality([1, 1, 1], policy)
    expect(awful.averageHundredths).toBe(100)
    expect(awful.flagForReview).toBe(false)
  })

  it('flags a branch that is bad enough for long enough', () => {
    expect(
      assessBranchQuality(
        Array.from({ length: 10 }, () => 2),
        policy,
      ).flagForReview,
    ).toBe(true)
  })

  it('leaves a branch exactly above the threshold alone', () => {
    // Nine threes and one four averages 3.1, above the 3.00 threshold.
    const scores = [...Array.from({ length: 9 }, () => 3), 4]
    const signal = assessBranchQuality(scores, policy)
    expect(signal.averageHundredths).toBe(310)
    expect(signal.flagForReview).toBe(false)
  })

  it('flags a branch sitting exactly on the threshold', () => {
    expect(
      assessBranchQuality(
        Array.from({ length: 12 }, () => 3),
        policy,
      ).flagForReview,
    ).toBe(true)
  })

  it('refuses a score it cannot have produced', () => {
    expect(() => assessBranchQuality([7], policy)).toThrow(DomainError)
  })

  it('refuses a policy that could never mean anything', () => {
    expect(() => assessBranchQuality([4], { ...policy, minimumSampleSize: 0 })).toThrow(DomainError)
    expect(() => assessBranchQuality([4], { ...policy, flagBelowHundredths: 900 })).toThrow(
      DomainError,
    )
  })
})

describe('planReorder', () => {
  function available(overrides: Partial<ReorderAvailability> = {}): ReorderAvailability {
    return {
      offeringId: 'a',
      orderable: true,
      unitPriceAmount: 50_000n,
      maximumQuantity: null,
      ...overrides,
    }
  }

  it('repeats what is still on the shelf', () => {
    const plan = planReorder(
      [
        { offeringId: 'a', quantity: 2 },
        { offeringId: 'b', quantity: 1 },
      ],
      [available(), available({ offeringId: 'b' })],
    )
    expect(plan.lines).toEqual([
      { offeringId: 'a', quantity: 2 },
      { offeringId: 'b', quantity: 1 },
    ])
    expect(plan.adjustments).toEqual([])
  })

  /**
   * A customer who taps "order again" and quietly receives two loaves instead
   * of four has been let down twice.
   */
  it('says what it dropped rather than omitting it', () => {
    const plan = planReorder(
      [
        { offeringId: 'a', quantity: 2 },
        { offeringId: 'gone', quantity: 3 },
      ],
      [available()],
    )
    expect(plan.lines).toEqual([{ offeringId: 'a', quantity: 2 }])
    expect(plan.adjustments).toEqual([
      { offeringId: 'gone', reason: ReorderDrop.UNAVAILABLE, quantity: 3 },
    ])
  })

  it('drops an offering the branch has stopped selling', () => {
    const plan = planReorder([{ offeringId: 'a', quantity: 2 }], [available({ orderable: false })])
    expect(plan.lines).toEqual([])
    expect(plan.adjustments[0]?.reason).toBe(ReorderDrop.UNAVAILABLE)
  })

  it('trims a quantity the branch can no longer manage, and says so', () => {
    const plan = planReorder(
      [{ offeringId: 'a', quantity: 6 }],
      [available({ maximumQuantity: 2 })],
    )
    expect(plan.lines).toEqual([{ offeringId: 'a', quantity: 2 }])
    expect(plan.adjustments).toEqual([
      { offeringId: 'a', reason: ReorderDrop.REDUCED, quantity: 2 },
    ])
  })

  it('treats a cap of nothing as unavailable', () => {
    const plan = planReorder(
      [{ offeringId: 'a', quantity: 3 }],
      [available({ maximumQuantity: 0 })],
    )
    expect(plan.lines).toEqual([])
    expect(plan.adjustments[0]?.reason).toBe(ReorderDrop.UNAVAILABLE)
  })

  it('ignores a line that was never worth anything', () => {
    expect(planReorder([{ offeringId: 'a', quantity: 0 }], [available()])).toEqual({
      lines: [],
      adjustments: [],
    })
  })

  it('returns an empty plan for an order with nothing left in it', () => {
    expect(planReorder([{ offeringId: 'a', quantity: 1 }], [])).toEqual({
      lines: [],
      adjustments: [{ offeringId: 'a', reason: ReorderDrop.UNAVAILABLE, quantity: 1 }],
    })
  })
})

describe('summariseBranchQuality', () => {
  const policy: QualityPolicy = { minimumSampleSize: 10, flagBelowHundredths: 300 }

  /**
   * The same rule from the other direction, so a report covering every branch
   * can group in the database instead of counting scores again in JavaScript.
   * A threshold applied in two places eventually becomes two thresholds.
   */
  it('agrees with the score-by-score reading', () => {
    const scores = [4, 4, 5, 3, 2, 5, 4, 4, 3, 4]
    const totalScore = scores.reduce((sum, score) => sum + score, 0)
    expect(summariseBranchQuality({ sampleSize: scores.length, totalScore }, policy)).toEqual(
      assessBranchQuality(scores, policy),
    )
  })

  it('reports nothing for a branch nobody has rated', () => {
    expect(summariseBranchQuality({ sampleSize: 0, totalScore: 0 }, policy)).toEqual({
      sampleSize: 0,
      averageHundredths: 0,
      flagForReview: false,
    })
  })

  /**
   * A sum that could not have come from scores in range means somebody counted
   * the wrong column, and a flag derived from it would accuse a real bakery.
   */
  it('refuses totals no set of scores could produce', () => {
    expect(() => summariseBranchQuality({ sampleSize: 2, totalScore: 11 }, policy)).toThrow(
      DomainError,
    )
    expect(() => summariseBranchQuality({ sampleSize: 3, totalScore: 2 }, policy)).toThrow(
      DomainError,
    )
    expect(() => summariseBranchQuality({ sampleSize: -1, totalScore: 0 }, policy)).toThrow(
      DomainError,
    )
  })
})
