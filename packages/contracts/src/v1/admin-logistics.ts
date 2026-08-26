import { z } from 'zod'

import { isoDateTimeSchema, moneySchema } from './common'

/**
 * What deliveries actually did, so the next logistics decision is not a guess.
 *
 * Every remaining item on the delivery plan is an optimisation, and each one
 * needs a before-and-after it can be judged against. This report is that
 * baseline, published before the optimisations exist rather than after — a
 * number first observed on the day it improves proves nothing.
 *
 * One naming decision runs through the whole shape and is worth stating: this
 * reports **revenue**, never cost. Nothing in the system records what a courier
 * is paid, so nothing here can subtract it. Calling a fee "cost per delivery"
 * would turn a report into a fiction that reads like margin.
 */
export const deliveryOutcomeCountsSchema = z.object({
  delivered: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** Cancelled before the courier finished. Never counted as a failure. */
  cancelled: z.number().int().min(0),
  /** Assigned, picked up, or out for delivery — no verdict yet. */
  inFlight: z.number().int().min(0),
  /**
   * Failures over deliveries that reached a verdict, 0–1, four places.
   * Null when nothing has settled: zero would read as "no failures", which is a
   * claim rather than the absence of one.
   */
  failureRate: z.number().min(0).max(1).nullable(),
})

export const deliveryEconomicsSchema = z.object({
  deliveries: z.number().int().min(0),
  /** Delivery fees charged across those deliveries. */
  feesCharged: moneySchema,
  distanceMetres: z.number().int().min(0),
  feePerDelivery: moneySchema.nullable(),
  feePerKilometre: moneySchema.nullable(),
  metresPerDelivery: z.number().int().min(0).nullable(),
})

export const batchingSchema = z.object({
  /** Distinct courier runs. One run is one courier's journey. */
  runs: z.number().int().min(0),
  deliveries: z.number().int().min(0),
  /**
   * Deliveries per run. Reads 1.00 until batching exists, which is the baseline
   * the batching work has to beat rather than a defect in the measurement.
   */
  density: z.number().min(0).nullable(),
})

export const routingCoverageSchema = z.object({
  /** Quotes priced on a distance the engine measured. */
  routed: z.number().int().min(0),
  /** Quotes priced on the scaled straight line, with a reason recorded. */
  estimated: z.number().int().min(0),
  /** Quotes from before routing existed, which recorded no source at all. */
  unattributed: z.number().int().min(0),
  /** Routed over attributed, 0–1, four places. Null when nothing is attributed. */
  routedShare: z.number().min(0).max(1).nullable(),
  /**
   * Why fares fell back, most frequent first. This is where a wrong API key or
   * an exhausted quota becomes visible as the thing it actually costs.
   */
  fallbackReasons: z.array(
    z.object({
      reasonCode: z.string().min(1).max(64),
      quotes: z.number().int().min(0),
    }),
  ),
})

export const detourCalibrationSchema = z.object({
  /** Routed deliveries with a straight line to compare against. */
  samples: z.number().int().min(0),
  /** The factor currently applied when routing is unavailable. */
  assumedFactor: z.number().min(1),
  /**
   * The factor the tenant's own routed deliveries imply. Null until there is
   * something to measure. When these two diverge, the assumption is the one
   * that should move.
   */
  measuredFactor: z.number().min(0).nullable(),
})

export const logisticsReportSchema = z.object({
  range: z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
  outcomes: deliveryOutcomeCountsSchema,
  economics: deliveryEconomicsSchema,
  batching: batchingSchema,
  routing: routingCoverageSchema,
  detour: detourCalibrationSchema,
  /**
   * Why deliveries failed, most frequent first. A single dominant reason is
   * usually one bad address or one absent courier, not a systemic problem.
   */
  failureReasons: z.array(
    z.object({
      reasonCode: z.string().min(1).max(64),
      deliveries: z.number().int().min(0),
    }),
  ),
})

export const logisticsReportEnvelopeSchema = z.object({
  success: z.literal(true),
  data: logisticsReportSchema,
  meta: z.object({}).passthrough(),
})

export type DeliveryOutcomeCountsContract = z.infer<typeof deliveryOutcomeCountsSchema>
export type DeliveryEconomicsContract = z.infer<typeof deliveryEconomicsSchema>
export type BatchingContract = z.infer<typeof batchingSchema>
export type RoutingCoverageContract = z.infer<typeof routingCoverageSchema>
export type DetourCalibrationContract = z.infer<typeof detourCalibrationSchema>
export type LogisticsReport = z.infer<typeof logisticsReportSchema>
