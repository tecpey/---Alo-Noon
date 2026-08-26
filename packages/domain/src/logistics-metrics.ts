import { DomainError } from './errors'

/**
 * The numbers that decide whether the next piece of logistics work is worth
 * building.
 *
 * Every remaining item on the delivery plan — batching several orders into one
 * run, assigning couriers by cost, tuning the fallback factor — is an
 * optimisation, and an optimisation without a measurement is a guess with a
 * budget. This module is the measurement half, kept pure so the arithmetic can
 * be read and argued about without a database.
 *
 * Three of these deliberately report awkward truths rather than flattering ones:
 *
 * **What a delivery costs us is not known.** Nothing in the system records what
 * a courier is paid, so nothing here claims to. What is measurable is what the
 * customer was *charged* and how far the bread actually went, which is enough to
 * find the deliveries that are underpriced relative to their distance — and not
 * enough to call it margin. Naming it revenue rather than cost is the difference
 * between a report and a fiction.
 *
 * **Batch density is 1.00 and will stay there until batching exists.** That is
 * not a bug in the metric; it is the baseline the batching work has to beat, and
 * publishing it now is what makes the improvement legible later.
 *
 * **The detour factor is a guess that this can retire.** Once routed distances
 * accumulate next to the straight lines they replaced, the real ratio is
 * measurable per city, and `measuredDetourFactor` is that measurement.
 */

export interface DeliveryOutcomeCounts {
  readonly delivered: number
  readonly failed: number
  readonly cancelled: number
  /** Still moving: assigned, picked up, or out for delivery. */
  readonly inFlight: number
}

/**
 * Failures as a share of deliveries that actually reached a verdict.
 *
 * Cancellations are excluded from both halves, and that is the whole subtlety: a
 * customer cancelling before the bread left is not a delivery that failed, and
 * counting it as one would make a good week of trading look like a bad week of
 * couriering. In-flight work is excluded for the same reason — it has no
 * outcome yet, and including it would make the rate drift down through the day
 * and jump back up each evening.
 *
 * Returns null rather than zero when nothing has settled. Zero would read as
 * "no failures", which is a claim; null reads as "nothing to say yet", which is
 * the truth.
 */
export function deliveryFailureRate(counts: DeliveryOutcomeCounts): number | null {
  assertCount(counts.delivered, 'delivered')
  assertCount(counts.failed, 'failed')
  const settled = counts.delivered + counts.failed
  if (settled === 0) return null
  return round(counts.failed / settled, 4)
}

export interface CourierRunTotals {
  /** Distinct courier runs in the period. One run is one courier's journey. */
  readonly runs: number
  /** Deliveries completed across those runs. */
  readonly deliveries: number
}

/**
 * Deliveries per courier run — the number batching exists to raise.
 *
 * Today every run carries one order, so this is 1.00 by construction. That is
 * worth reporting rather than hiding: it is the baseline, and the first batched
 * week is only visibly better because this number was already being published
 * when it was not.
 */
export function batchDensity(totals: CourierRunTotals): number | null {
  assertCount(totals.runs, 'runs')
  assertCount(totals.deliveries, 'deliveries')
  if (totals.runs === 0) return null
  return round(totals.deliveries / totals.runs, 2)
}

export interface DeliveryRevenueTotals {
  /** Delivery fees charged, in IRR minor units. */
  readonly feeAmount: bigint
  /** Distance actually travelled for those fees, in metres. */
  readonly distanceMetres: number
  readonly deliveries: number
}

export interface DeliveryEconomics {
  /** Average fee charged per delivery, in IRR minor units. */
  readonly feePerDelivery: bigint | null
  /** Average fee per kilometre travelled, in IRR minor units. */
  readonly feePerKilometre: bigint | null
  /** Average distance per delivery, in metres. */
  readonly metresPerDelivery: number | null
}

/**
 * What deliveries earned against how far they went.
 *
 * Integer division throughout, rounding down: these are Rial amounts an operator
 * compares against a courier's rate card, and a fraction of a Rial is not a
 * thing. Rounding down keeps an average from ever reading higher than what was
 * actually taken.
 */
export function deliveryEconomics(totals: DeliveryRevenueTotals): Readonly<DeliveryEconomics> {
  assertCount(totals.deliveries, 'deliveries')
  assertCount(totals.distanceMetres, 'distanceMetres')
  if (totals.feeAmount < 0n) {
    throw new DomainError('INVALID_LOGISTICS_METRIC', 'A delivery fee total cannot be negative')
  }
  if (totals.deliveries === 0) {
    return Object.freeze({ feePerDelivery: null, feePerKilometre: null, metresPerDelivery: null })
  }
  const kilometres = BigInt(Math.round(totals.distanceMetres / 1_000))
  return Object.freeze({
    feePerDelivery: totals.feeAmount / BigInt(totals.deliveries),
    // A period whose deliveries were all under 500 metres rounds to zero
    // kilometres; reporting no rate is honest, dividing by zero is not.
    feePerKilometre: kilometres > 0n ? totals.feeAmount / kilometres : null,
    metresPerDelivery: Math.round(totals.distanceMetres / totals.deliveries),
  })
}

export interface RoutingCoverage {
  /** Quotes priced on a distance the routing engine measured. */
  readonly routed: number
  /** Quotes priced on the scaled straight line. */
  readonly estimated: number
  /** Quotes from before routing existed, which recorded no source at all. */
  readonly unattributed: number
}

/**
 * The share of fares that were actually measured.
 *
 * This is the operational health of routing, and it is more useful than an
 * uptime graph because it is denominated in the thing that matters: money
 * charged to customers. A week at 0.6 means four fares in ten were guessed, and
 * every one of them is a fare that cannot be defended if disputed.
 *
 * Quotes predating routing are counted separately rather than folded into
 * either side. They were not estimated by this system's fallback — they were
 * priced on an unscaled straight line by a version that had no concept of
 * provenance — and lumping them in would make a historical range look like a
 * routing incident.
 */
export function routedShare(coverage: RoutingCoverage): number | null {
  assertCount(coverage.routed, 'routed')
  assertCount(coverage.estimated, 'estimated')
  const attributed = coverage.routed + coverage.estimated
  if (attributed === 0) return null
  return round(coverage.routed / attributed, 4)
}

export interface DetourSample {
  /** What the road turned out to be, in metres. */
  readonly routedMetres: number
  /** The straight line between the same two points, in metres. */
  readonly straightLineMetres: number
}

/**
 * The real ratio of road to straight line, measured from routed deliveries.
 *
 * `URBAN_DETOUR_FACTOR` is a stated assumption — 1.3, chosen from published
 * ranges before this system had measured anything. This is what replaces it: an
 * operator with a few hundred routed deliveries can read their city's actual
 * number off a report and set the fallback from evidence.
 *
 * The mean is taken over per-delivery ratios rather than as total road over
 * total straight line, because the fallback is applied to one delivery at a
 * time. A single ten-kilometre run would otherwise dominate a thousand short
 * ones and produce a factor that is right for a journey nobody makes.
 *
 * Samples with no straight-line distance are dropped: a ratio against zero is
 * infinite, and a delivery to the branch's own doorstep says nothing about how
 * winding the roads are.
 */
export function measuredDetourFactor(samples: readonly DetourSample[]): number | null {
  let total = 0
  let counted = 0
  for (const sample of samples) {
    assertCount(sample.routedMetres, 'routedMetres')
    assertCount(sample.straightLineMetres, 'straightLineMetres')
    if (sample.straightLineMetres === 0) continue
    total += sample.routedMetres / sample.straightLineMetres
    counted += 1
  }
  if (counted === 0) return null
  return round(total / counted, 3)
}

/**
 * How many routing calls the cache saved.
 *
 * Every miss is money. A tenant sitting at a low hit rate is either serving a
 * constantly changing set of addresses — which is what a growing city looks
 * like — or has a TTL set too short for how fast its roads change, and the two
 * are told apart by whether the rate improves as the address book fills.
 */
export function cacheHitRate(hits: number, misses: number): number | null {
  assertCount(hits, 'hits')
  assertCount(misses, 'misses')
  const total = hits + misses
  if (total === 0) return null
  return round(hits / total, 4)
}

function assertCount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError('INVALID_LOGISTICS_METRIC', `${name} must be a non-negative number`)
  }
}

/** Fixed precision, so a report does not differ between two runs of the same data. */
function round(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}
