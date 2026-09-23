import { z } from 'zod'

import { moneySchema, responseMetaSchema, uuidSchema } from './common'

export const activeCitySummarySchema = z.object({
  id: uuidSchema,
  code: z.string().min(1).max(32),
  nameFa: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
})
export type ActiveCitySummary = z.infer<typeof activeCitySummarySchema>

export const activeCitiesEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(activeCitySummarySchema),
  meta: responseMetaSchema,
})
export type ActiveCitiesEnvelope = z.infer<typeof activeCitiesEnvelopeSchema>

export const addressInputSchema = z.object({
  cityId: uuidSchema,
  operationalZoneId: uuidSchema.optional(),
  label: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().regex(/^\+98\d{10}$/),
  addressLine: z.string().trim().min(10).max(500),
  postalCode: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  latitude: z.number().min(35).max(38.5),
  longitude: z.number().min(49).max(54.5),
  deliveryInstructions: z.string().trim().max(500).optional(),
})
export type AddressInput = z.infer<typeof addressInputSchema>

export const addressCreateSchema = addressInputSchema
  .omit({ operationalZoneId: true })
  .extend({ idempotencyKey: z.string().trim().min(16).max(128) })
export type AddressCreate = z.infer<typeof addressCreateSchema>

export const addressSummarySchema = z.object({
  id: uuidSchema,
  cityId: uuidSchema,
  serviceAreaId: uuidSchema,
  operationalZoneId: uuidSchema,
  label: z.string().min(1).max(80),
  recipientName: z.string().min(1).max(120),
  recipientPhone: z.string().regex(/^\+98\d{10}$/),
  addressLine: z.string().min(1).max(500),
  postalCode: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deliveryInstructions: z.string().max(500).optional(),
  verificationStatus: z.enum([
    'UNVERIFIED',
    'CUSTOMER_CONFIRMED',
    'OPERATIONS_VERIFIED',
    'REJECTED',
  ]),
  createdAt: z.string().datetime({ offset: true }),
})
export type AddressSummary = z.infer<typeof addressSummarySchema>

export const addressEnvelopeSchema = z.object({
  success: z.literal(true),
  data: addressSummarySchema,
  meta: responseMetaSchema,
})

export const addressesEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(addressSummarySchema),
  meta: responseMetaSchema,
})

export const serviceabilityRequestSchema = z.object({
  cityId: uuidSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  requestedAt: z.string().datetime({ offset: true }).optional(),
})
export type ServiceabilityRequest = z.infer<typeof serviceabilityRequestSchema>

export const serviceabilityResponseSchema = z.object({
  serviceable: z.boolean(),
  operationalZoneId: uuidSchema.optional(),
  serviceAreaId: uuidSchema.optional(),
  reason: z.enum(['OUTSIDE_CITY', 'OUTSIDE_SERVICE_AREA', 'ZONE_SUSPENDED']).optional(),
  evaluatedAt: z.string().datetime({ offset: true }),
})
export type ServiceabilityResponse = z.infer<typeof serviceabilityResponseSchema>

export const serviceabilityEnvelopeSchema = z.object({
  success: z.literal(true),
  data: serviceabilityResponseSchema,
  meta: responseMetaSchema,
})
export type ServiceabilityEnvelope = z.infer<typeof serviceabilityEnvelopeSchema>

/* --------------------------------------------------- the fare, shown early */

export const deliveryEstimateQuerySchema = z.object({
  cityId: uuidSchema,
  /**
   * Optional, because the shelf is rendered before a doorstep exists. Given, a
   * zone's own tariff replaces the city-wide one; absent, the city-wide tariff
   * is what can honestly be quoted.
   */
  operationalZoneId: uuidSchema.optional(),
})
export type DeliveryEstimateQuery = z.infer<typeof deliveryEstimateQuerySchema>

/**
 * The delivery fare, said before the customer has spent anything.
 *
 * Extra costs that appear late are the largest fixable cause of abandoned
 * baskets Baymard measures — 39% of shoppers — and this is the answer to it.
 * But the answer only works if the early number survives contact with the
 * final one, so `basis` travels with `amount` and the interface is required to
 * word the three cases differently:
 *
 * - `EXACT` — one flat tariff and no provider to consult. This *is* the fare.
 * - `FROM` — a floor. Distance or the customer's choice of vehicle can raise
 *   it; nothing can lower it.
 * - `INDICATIVE` — a delivery provider quotes at checkout and its answer wins,
 *   the way it does in Tapsi's and Snapp's own applications. Our tariff is a
 *   guide, and the interface must not print it as a promise.
 *
 * `amount` without `basis` would be a number the shop cannot stand behind, so
 * neither field is optional.
 */
export const deliveryEstimateSchema = z.object({
  basis: z.enum(['EXACT', 'FROM', 'INDICATIVE']),
  amount: moneySchema,
  /** The vehicle the amount belongs to: the cheapest one this scope offers. */
  vehicleProfile: z.enum(['MOTORCYCLE', 'CAR']),
  /** Set when the tariff stops charging above a basket size. */
  freeOver: moneySchema.nullable(),
  /** Set when the tariff refuses baskets below a size. */
  minimumOrder: moneySchema.nullable(),
})
export type DeliveryEstimate = z.infer<typeof deliveryEstimateSchema>

/**
 * `estimate: null` means no tariff is published for this scope, which is a
 * shelf with no fare line rather than a failure. It is deliberately not an
 * error envelope: a missing tariff must cost the customer a line of text and
 * never the shop.
 */
export const deliveryEstimateResultSchema = z.object({
  estimate: deliveryEstimateSchema.nullable(),
})
export type DeliveryEstimateResult = z.infer<typeof deliveryEstimateResultSchema>

export const deliveryEstimateEnvelopeSchema = z.object({
  success: z.literal(true),
  data: deliveryEstimateResultSchema,
  meta: responseMetaSchema,
})
export type DeliveryEstimateEnvelope = z.infer<typeof deliveryEstimateEnvelopeSchema>

/* ------------------------------------------------------------------ places */

/**
 * Finding an address without standing at it.
 *
 * Coordinates used to be obtainable one way only — `navigator.geolocation` —
 * which meant a customer who refused the permission, or whose fix never
 * arrived indoors, could not give an address at all and so could not order.
 * These two operations are the second way.
 *
 * Both cost the tenant money per call, which is why the term has a floor here
 * as well as in the handler, and why a coordinate outside the serviceable box
 * is refused before anything is spent looking it up.
 */

/**
 * The shortest term worth a paid lookup. Mirrors
 * `PLACE_SEARCH_MIN_TERM_LENGTH` in the domain package, which cannot be
 * imported here — this package deliberately depends on nothing but zod — so a
 * test pins the two together rather than trusting them to stay equal.
 */
export const PLACE_SEARCH_MIN_TERM = 3
export const PLACE_SEARCH_MAX_TERM = 120
/** Mirrors `PLACE_SEARCH_MAX_RESULTS`, pinned by the same test. */
export const PLACE_SEARCH_RESULT_LIMIT = 8

export const placeSearchQuerySchema = z.object({
  term: z.string().trim().min(PLACE_SEARCH_MIN_TERM).max(PLACE_SEARCH_MAX_TERM),
  /**
   * Which city to look in. Optional because a search still works without it,
   * and worth sending because without it a common street name answers with the
   * one in Tehran whichever city the customer is ordering from.
   */
  cityId: uuidSchema.optional(),
})
export type PlaceSearchQuery = z.infer<typeof placeSearchQuerySchema>

export const placeCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  address: z.string().min(1).max(500).nullable(),
  // The same box `addressInputSchema` accepts. A candidate the customer could
  // not then save as an address is a row that only exists to be rejected.
  latitude: z.number().min(35).max(38.5),
  longitude: z.number().min(49).max(54.5),
  distanceMetres: z.number().int().nonnegative().nullable(),
})
export type PlaceCandidate = z.infer<typeof placeCandidateSchema>

/**
 * `available` is not the same as an empty list, and the interface must not
 * treat them alike. False means this tenant has no mapping configured, so the
 * search box should not be offered at all; true with nothing in `candidates`
 * means the provider answered and knows nowhere by that name, which is worth
 * telling the customer so they try different words.
 */
export const placeSearchResultSchema = z.object({
  available: z.boolean(),
  candidates: z.array(placeCandidateSchema).max(PLACE_SEARCH_RESULT_LIMIT),
})
export type PlaceSearchResult = z.infer<typeof placeSearchResultSchema>

export const placeSearchEnvelopeSchema = z.object({
  success: z.literal(true),
  data: placeSearchResultSchema,
  meta: responseMetaSchema,
})
export type PlaceSearchEnvelope = z.infer<typeof placeSearchEnvelopeSchema>

export const reverseGeocodeQuerySchema = z.object({
  latitude: z.number().min(35).max(38.5),
  longitude: z.number().min(49).max(54.5),
})
export type ReverseGeocodeQuery = z.infer<typeof reverseGeocodeQuerySchema>

/**
 * `formattedAddress` is null whenever the provider did not hand back a whole
 * line. Nothing assembles one from parts: the customer reads this to decide
 * whether the pin is their house, and a plausible sentence that is subtly wrong
 * is worse than an honest blank.
 */
export const reverseGeocodeResultSchema = z.object({
  available: z.boolean(),
  formattedAddress: z.string().min(1).max(500).nullable(),
})
export type ReverseGeocodeResult = z.infer<typeof reverseGeocodeResultSchema>

export const reverseGeocodeEnvelopeSchema = z.object({
  success: z.literal(true),
  data: reverseGeocodeResultSchema,
  meta: responseMetaSchema,
})
export type ReverseGeocodeEnvelope = z.infer<typeof reverseGeocodeEnvelopeSchema>
