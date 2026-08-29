import { DomainError } from './errors'

/**
 * Coming back: reordering, rating, and keeping a favourite.
 *
 * Bread is bought again. Not occasionally — most mornings, and usually the same
 * two or three loaves. That single fact is what separates this from a
 * restaurant platform: the second order matters more than the first, and every
 * tap between a customer and yesterday's basket is a tap that loses one.
 *
 * So reorder is the feature here and the other two support it. A favourite is
 * how somebody says "this is my bread" before they have an order history to
 * repeat. A rating is how the platform learns which bakery is worth sending
 * them back to — and, when the answer turns bad, how a partner gets looked at
 * before the complaints arrive.
 */

export const RATING_MIN_SCORE = 1
export const RATING_MAX_SCORE = 5
/** Longest a comment may be. Enough for a sentence, not enough for an essay. */
export const RATING_MAX_COMMENT = 500

/**
 * How long after delivery a rating is still about the bread.
 *
 * A month. Past that it is a mood rather than a memory, and letting it in would
 * let somebody relitigate an old order every time they were annoyed about a new
 * one.
 */
export const RATING_WINDOW_DAYS = 30

const MILLISECONDS_PER_DAY = 86_400_000

export interface OrderRatingInput {
  /** How the bread was: warm, fresh, the thing they ordered. */
  readonly breadScore: number
  /** How the delivery was. Optional — plenty of people only care about one. */
  readonly deliveryScore?: number
  readonly comment?: string
}

/** What is true about the order being rated. */
export interface OrderRatingContext {
  /** Terminal states only. An order still in an oven has nothing to say about. */
  readonly orderState: string
  readonly deliveredAt: Date | null
  readonly now: Date
  readonly alreadyRated: boolean
}

export const RatingRefusal = {
  NOT_DELIVERED: 'RATING_ORDER_NOT_DELIVERED',
  ALREADY_RATED: 'RATING_ALREADY_SUBMITTED',
  WINDOW_CLOSED: 'RATING_WINDOW_CLOSED',
  INVALID_SCORE: 'RATING_INVALID_SCORE',
  COMMENT_TOO_LONG: 'RATING_COMMENT_TOO_LONG',
} as const
export type RatingRefusal = (typeof RatingRefusal)[keyof typeof RatingRefusal]

/**
 * Whether this rating may be recorded.
 *
 * Checked in the order a person would explain it: there is nothing to rate yet,
 * or you already did, or it was too long ago, and only then whether the numbers
 * make sense. Somebody rating a month-old order should be told the window
 * closed, not that their score is out of range.
 */
export function checkOrderRating(
  input: OrderRatingInput,
  context: OrderRatingContext,
): RatingRefusal | null {
  if (context.orderState !== 'COMPLETED' || !context.deliveredAt) {
    return RatingRefusal.NOT_DELIVERED
  }
  if (context.alreadyRated) return RatingRefusal.ALREADY_RATED
  if (
    context.now.getTime() - context.deliveredAt.getTime() >
    RATING_WINDOW_DAYS * MILLISECONDS_PER_DAY
  ) {
    return RatingRefusal.WINDOW_CLOSED
  }
  if (!isScore(input.breadScore)) return RatingRefusal.INVALID_SCORE
  if (input.deliveryScore !== undefined && !isScore(input.deliveryScore)) {
    return RatingRefusal.INVALID_SCORE
  }
  if (input.comment !== undefined && input.comment.length > RATING_MAX_COMMENT) {
    return RatingRefusal.COMMENT_TOO_LONG
  }
  return null
}

function isScore(value: number): boolean {
  return Number.isSafeInteger(value) && value >= RATING_MIN_SCORE && value <= RATING_MAX_SCORE
}

/** How a branch's ratings are read, and when they mean something. */
export interface QualityPolicy {
  /**
   * Ratings needed before the average says anything at all.
   *
   * A bakery is not judged on three opinions. Below this the average is
   * reported but never acted on, because the alternative is a partner losing
   * their livelihood to one bad morning and two strangers.
   */
  readonly minimumSampleSize: number
  /**
   * The average, in hundredths, at or below which a branch is flagged.
   *
   * Hundredths rather than a fraction: this number is compared, stored and
   * shown, and a float that is 3.9999999 on one machine and 4.0 on another
   * makes a flag that appears and disappears on its own.
   */
  readonly flagBelowHundredths: number
}

export interface BranchQualitySignal {
  readonly sampleSize: number
  /** Mean bread score in hundredths — 425 is 4.25. Zero when nobody has rated. */
  readonly averageHundredths: number
  /**
   * Whether somebody should look at this branch.
   *
   * Deliberately a flag and never a suspension. Taking a bakery off the
   * platform automatically on a handful of scores is a decision no algorithm
   * should make alone — it ends a partnership, and it is exactly the kind of
   * call that has to have a person's name against it.
   */
  readonly flagForReview: boolean
}

/**
 * What a branch's recent bread scores add up to.
 *
 * Integer arithmetic throughout, rounded to hundredths. There is no float here
 * for the same reason there is none in the ledger: a number that is compared
 * against a threshold must mean the same thing everywhere it is read.
 */
export function assessBranchQuality(
  scores: readonly number[],
  policy: QualityPolicy,
): BranchQualitySignal {
  let totalScore = 0
  for (const score of scores) {
    if (!isScore(score)) {
      throw new DomainError('INVALID_RATING', 'A rating score is out of range', { score })
    }
    totalScore += score
  }
  return summariseBranchQuality({ sampleSize: scores.length, totalScore }, policy)
}

/**
 * The same judgement, from a count and a sum somebody else added up.
 *
 * Exists so a report covering every branch can group in the database rather
 * than pulling every score across the wire to count them again in JavaScript.
 * The rule lives here either way — a threshold applied in two places is a
 * threshold that will eventually be two different thresholds.
 */
export function summariseBranchQuality(
  totals: { readonly sampleSize: number; readonly totalScore: number },
  policy: QualityPolicy,
): BranchQualitySignal {
  assertPolicy(policy)
  if (
    !Number.isSafeInteger(totals.sampleSize) ||
    totals.sampleSize < 0 ||
    !Number.isSafeInteger(totals.totalScore) ||
    totals.totalScore < 0
  ) {
    throw new DomainError('INVALID_RATING', 'Rating totals are not usable', totals)
  }
  if (totals.sampleSize === 0) {
    return { sampleSize: 0, averageHundredths: 0, flagForReview: false }
  }
  // A sum that could not have come from scores in range means somebody counted
  // the wrong thing, and a flag derived from it would accuse a real bakery.
  if (
    totals.totalScore < totals.sampleSize * RATING_MIN_SCORE ||
    totals.totalScore > totals.sampleSize * RATING_MAX_SCORE
  ) {
    throw new DomainError('INVALID_RATING', 'Rating totals are out of range', totals)
  }
  // Rounded rather than truncated: this is a reading of the scores, not money,
  // and rounding down would report a branch a shade worse than it is every time
  // the mean is not exact.
  const averageHundredths = Math.round((totals.totalScore * 100) / totals.sampleSize)
  return {
    sampleSize: totals.sampleSize,
    averageHundredths,
    flagForReview:
      totals.sampleSize >= policy.minimumSampleSize &&
      averageHundredths <= policy.flagBelowHundredths,
  }
}

function assertPolicy(policy: QualityPolicy): void {
  if (!Number.isSafeInteger(policy.minimumSampleSize) || policy.minimumSampleSize < 1) {
    throw new DomainError('INVALID_RATING', 'A quality policy needs a sample size above zero')
  }
  if (
    !Number.isSafeInteger(policy.flagBelowHundredths) ||
    policy.flagBelowHundredths < RATING_MIN_SCORE * 100 ||
    policy.flagBelowHundredths > RATING_MAX_SCORE * 100
  ) {
    throw new DomainError('INVALID_RATING', 'A quality threshold must fall inside the score range')
  }
}

/** One line of a basket being rebuilt from a past order. */
export interface ReorderCandidate {
  readonly offeringId: string
  readonly quantity: number
}

/** What a previously bought offering looks like today. */
export interface ReorderAvailability {
  readonly offeringId: string
  readonly orderable: boolean
  /** What one costs now — not what it cost then. */
  readonly unitPriceAmount: bigint
  /** Null when the branch does not cap it. */
  readonly maximumQuantity: number | null
}

export const ReorderDrop = {
  UNAVAILABLE: 'REORDER_OFFERING_UNAVAILABLE',
  REDUCED: 'REORDER_QUANTITY_REDUCED',
} as const
export type ReorderDrop = (typeof ReorderDrop)[keyof typeof ReorderDrop]

export interface ReorderPlan {
  readonly lines: readonly { offeringId: string; quantity: number }[]
  /** Everything that could not be repeated exactly, and why. */
  readonly adjustments: readonly { offeringId: string; reason: ReorderDrop; quantity: number }[]
}

/**
 * What of a past order can be bought again today.
 *
 * Nothing is copied from the old order except *what* and *how many*. Prices are
 * read fresh, because a basket rebuilt at three-week-old prices sells bread
 * below what it costs to bake — and because a customer who is quietly charged
 * yesterday's price is a customer whose receipt will not match anything.
 *
 * Everything dropped or trimmed is reported rather than silently omitted. A
 * customer who taps "order again" and receives two loaves instead of four has
 * been let down twice: once by the bakery and once by the interface that did
 * not mention it.
 */
export function planReorder(
  previous: readonly ReorderCandidate[],
  availability: readonly ReorderAvailability[],
): ReorderPlan {
  const today = new Map(availability.map((entry) => [entry.offeringId, entry]))
  const lines: { offeringId: string; quantity: number }[] = []
  const adjustments: { offeringId: string; reason: ReorderDrop; quantity: number }[] = []

  for (const candidate of previous) {
    if (candidate.quantity <= 0) continue
    const entry = today.get(candidate.offeringId)
    if (!entry || !entry.orderable) {
      adjustments.push({
        offeringId: candidate.offeringId,
        reason: ReorderDrop.UNAVAILABLE,
        quantity: candidate.quantity,
      })
      continue
    }
    const quantity =
      entry.maximumQuantity === null
        ? candidate.quantity
        : Math.min(candidate.quantity, entry.maximumQuantity)
    if (quantity <= 0) {
      adjustments.push({
        offeringId: candidate.offeringId,
        reason: ReorderDrop.UNAVAILABLE,
        quantity: candidate.quantity,
      })
      continue
    }
    if (quantity < candidate.quantity) {
      adjustments.push({
        offeringId: candidate.offeringId,
        reason: ReorderDrop.REDUCED,
        quantity,
      })
    }
    lines.push({ offeringId: candidate.offeringId, quantity })
  }

  return { lines, adjustments }
}
