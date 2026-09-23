import { DomainError } from './errors'

/** Mirrors `RoutingProfile`, restated so this module keeps no import cycle. */
export type DeliveryVehicleProfile = 'MOTORCYCLE' | 'CAR'

export type DeliveryPricingMode = 'FLAT' | 'DISTANCE_BANDED'

export interface DeliveryPricingRuleCandidate {
  id: string
  operationalZoneId: string | null
  /**
   * Which vehicle this tariff prices. A car and a motorcycle are separate
   * tariffs rather than one rate with a surcharge, because they differ in both
   * the call-out and the rate per kilometre and the two do not move together.
   */
  vehicleProfile: DeliveryVehicleProfile
  version: number
  mode: DeliveryPricingMode
  baseFeeAmount: bigint
  perKmFeeAmount: bigint | null
  minimumOrderAmount: bigint | null
  freeDeliveryThresholdAmount: bigint | null
  currency: 'IRR'
}

export interface DeliveryCoordinates {
  latitude: number
  longitude: number
}

export interface DeliveryFeeDecision {
  ruleId: string
  ruleVersion: number
  distanceMeters: number
  deliveryFeeAmount: bigint
  currency: 'IRR'
}

const EARTH_RADIUS_METERS = 6_371_000

export function calculateDeliveryDistanceMeters(
  origin: DeliveryCoordinates,
  destination: DeliveryCoordinates,
): number {
  assertCoordinates(origin)
  assertCoordinates(destination)
  const latitudeDelta = degreesToRadians(destination.latitude - origin.latitude)
  const longitudeDelta = degreesToRadians(destination.longitude - origin.longitude)
  const originLatitude = degreesToRadians(origin.latitude)
  const destinationLatitude = degreesToRadians(destination.latitude)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2
  const distance =
    2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  return Math.ceil(distance)
}

/**
 * The tariff for this zone and this vehicle.
 *
 * The vehicle narrows first and the zone second, which is the order that keeps
 * the fallback honest: a city-wide car tariff is a sensible thing to fall back
 * to when a zone has not set its own, while a zone's motorcycle tariff is never
 * an acceptable substitute for a car's. Filtering by zone first and vehicle
 * second would have produced exactly that substitution whenever a zone had a
 * motorcycle rate and the city had a car one.
 *
 * A missing tariff for the required vehicle is its own error rather than the
 * generic one. It is the failure an operator will actually hit — the first
 * factory order into a city whose car rate nobody has published — and it needs
 * to say what to do, not that pricing is "missing".
 */
export function selectDeliveryPricingRule(
  rules: readonly DeliveryPricingRuleCandidate[],
  operationalZoneId: string,
  vehicleProfile: DeliveryVehicleProfile = 'MOTORCYCLE',
): Readonly<DeliveryPricingRuleCandidate> {
  // Nothing at all and nothing-for-this-vehicle are different failures with
  // different remedies — "pricing is not set up for this city" against "publish
  // a car rate" — so they are separated before either is reported. This is why
  // the caller hands over every vehicle's tariffs rather than pre-filtering:
  // narrowing in the query would collapse the two back into one.
  if (rules.length === 0) {
    throw new DomainError('DELIVERY_PRICING_RULE_MISSING', 'No delivery pricing rule applies')
  }
  const forVehicle = rules.filter((rule) => rule.vehicleProfile === vehicleProfile)
  if (forVehicle.length === 0) {
    throw new DomainError(
      'DELIVERY_VEHICLE_TARIFF_MISSING',
      'No delivery tariff is published for the vehicle this order requires',
      { vehicleProfile },
    )
  }
  const zoneRules = forVehicle.filter((rule) => rule.operationalZoneId === operationalZoneId)
  const candidates =
    zoneRules.length > 0 ? zoneRules : forVehicle.filter((rule) => rule.operationalZoneId === null)
  if (candidates.length === 0) {
    throw new DomainError('DELIVERY_PRICING_RULE_MISSING', 'No delivery pricing rule applies')
  }
  if (candidates.length !== 1) {
    throw new DomainError('DELIVERY_PRICING_RULE_AMBIGUOUS', 'Delivery pricing is ambiguous')
  }
  return Object.freeze({ ...candidates[0]! })
}

export function calculateDeliveryFee(
  rule: DeliveryPricingRuleCandidate,
  subtotalAmount: bigint,
  distanceMeters: number,
): Readonly<DeliveryFeeDecision> {
  if (subtotalAmount < 0n || !Number.isSafeInteger(distanceMeters) || distanceMeters < 0) {
    throw new DomainError('INVALID_DELIVERY_PRICING_INPUT', 'Delivery pricing input is invalid')
  }
  if (rule.minimumOrderAmount !== null && subtotalAmount < rule.minimumOrderAmount) {
    throw new DomainError('MINIMUM_ORDER_NOT_MET', 'The minimum order amount was not met', {
      minimumOrderAmount: rule.minimumOrderAmount.toString(),
    })
  }

  let deliveryFeeAmount: bigint
  if (
    rule.freeDeliveryThresholdAmount !== null &&
    subtotalAmount >= rule.freeDeliveryThresholdAmount
  ) {
    deliveryFeeAmount = 0n
  } else if (rule.mode === 'FLAT') {
    deliveryFeeAmount = rule.baseFeeAmount
  } else {
    if (rule.perKmFeeAmount === null) {
      throw new DomainError(
        'INVALID_DELIVERY_PRICING_RULE',
        'Distance pricing requires a per-km fee',
      )
    }
    deliveryFeeAmount =
      rule.baseFeeAmount + BigInt(Math.ceil(distanceMeters / 1_000)) * rule.perKmFeeAmount
  }

  return Object.freeze({
    ruleId: rule.id,
    ruleVersion: rule.version,
    distanceMeters,
    deliveryFeeAmount,
    currency: rule.currency,
  })
}

/**
 * What kind of claim a fare shown before checkout is allowed to make.
 *
 * This enum exists because "کرایه از ۵٬۰۰۰ تومان" and "کرایه ۵٬۰۰۰ تومان" are
 * different promises, and a shop that makes the second one and then charges
 * more has done the thing this whole feature was meant to prevent. Extra costs
 * appearing late are the largest *fixable* cause of abandonment Baymard
 * measures — 39% of shoppers — but the fix is only a fix if the early number
 * survives contact with the final one.
 *
 * - `EXACT` — one flat tariff applies and no provider will be consulted, so
 *   this is the fare. Nothing about distance or vehicle can move it.
 * - `FROM` — a floor. Either the tariff charges by distance, or the customer
 *   has a choice of vehicles and may pick the dearer one. The final fare is
 *   this or more, never less.
 * - `INDICATIVE` — a delivery provider will quote at checkout and its answer
 *   wins, so our own tariff is a guide rather than a bound. This is the honest
 *   answer for a tenant on Tapsi or Snapp: the fare is computed live, the way
 *   it is in their own applications, and pretending otherwise on a shelf would
 *   be inventing a number.
 */
export type DeliveryEstimateBasis = 'EXACT' | 'FROM' | 'INDICATIVE'

export interface DeliveryEstimate {
  basis: DeliveryEstimateBasis
  /** The number to show, in the smallest unit, before any basket discount. */
  amount: bigint
  currency: 'IRR'
  /** The vehicle the shown amount belongs to — the cheapest one on offer. */
  vehicleProfile: DeliveryVehicleProfile
  /** Set when this tariff stops charging above a basket size. */
  freeOverAmount: bigint | null
  /** Set when this tariff refuses baskets below a size. */
  minimumOrderAmount: bigint | null
}

/**
 * The cheapest fare this scope can produce, for showing beside the bread.
 *
 * Deliberately not `calculateDeliveryFee` with a distance of zero. Zero metres
 * is not a delivery, and `calculateDeliveryFee` rounds distance up to whole
 * kilometres — so a distance-banded tariff bills one kilometre for any journey
 * at all, and its real floor is `base + perKm` rather than `base`. Showing the
 * base alone would under-quote every single order by exactly one band, which is
 * the same broken promise as hiding the fee, arrived at politely.
 *
 * Returns null when nothing is published for this scope. A shelf with no fare
 * line is correct then; a shelf claiming free delivery would not be.
 */
export function estimateDeliveryFee(
  rules: readonly DeliveryPricingRuleCandidate[],
  options: {
    /** Null before a doorstep is known; city-wide tariffs still apply. */
    operationalZoneId: string | null
    /**
     * Whether a delivery provider is configured, healthy and will be asked.
     * When it will, its answer replaces ours at checkout — so the claim this
     * estimate may make drops to `INDICATIVE` whatever the tariffs say.
     */
    providerMayQuote: boolean
  },
): Readonly<DeliveryEstimate> | null {
  // The same zone-then-city fallback `selectDeliveryPricingRule` applies, per
  // vehicle: a zone's own tariff replaces the city-wide one for that vehicle,
  // and a vehicle with no zone tariff still falls back to the city.
  const profiles: DeliveryVehicleProfile[] = ['MOTORCYCLE', 'CAR']
  const applicable: DeliveryPricingRuleCandidate[] = []
  for (const profile of profiles) {
    const forVehicle = rules.filter((rule) => rule.vehicleProfile === profile)
    if (forVehicle.length === 0) continue
    const zoneRules =
      options.operationalZoneId === null
        ? []
        : forVehicle.filter((rule) => rule.operationalZoneId === options.operationalZoneId)
    const candidates =
      zoneRules.length > 0
        ? zoneRules
        : forVehicle.filter((rule) => rule.operationalZoneId === null)
    // An ambiguous scope is a configuration fault that `selectDeliveryPricingRule`
    // reports loudly at quote time. Here it must not: this is a decoration on a
    // shelf, and taking the shop down over it would be the worse failure.
    if (candidates.length === 1) applicable.push(candidates[0]!)
  }
  if (applicable.length === 0) return null

  const floors = applicable.map((rule) => ({ rule, floor: tariffFloor(rule) }))
  const cheapest = floors.reduce((best, entry) => (entry.floor < best.floor ? entry : best))

  const basis: DeliveryEstimateBasis = options.providerMayQuote
    ? 'INDICATIVE'
    : // Exact only when nothing left can move it: one tariff, charged flat. A
      // second vehicle means the customer can choose the dearer one, and a
      // distance-banded tariff means the road decides.
      applicable.length === 1 && cheapest.rule.mode === 'FLAT'
      ? 'EXACT'
      : 'FROM'

  return Object.freeze({
    basis,
    amount: cheapest.floor,
    currency: cheapest.rule.currency,
    vehicleProfile: cheapest.rule.vehicleProfile,
    freeOverAmount: cheapest.rule.freeDeliveryThresholdAmount,
    minimumOrderAmount: cheapest.rule.minimumOrderAmount,
  })
}

/** The least this tariff can charge for a journey longer than nothing. */
function tariffFloor(rule: DeliveryPricingRuleCandidate): bigint {
  if (rule.mode === 'FLAT') return rule.baseFeeAmount
  return rule.baseFeeAmount + (rule.perKmFeeAmount ?? 0n)
}

function assertCoordinates(value: DeliveryCoordinates): void {
  if (
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    value.longitude < -180 ||
    value.longitude > 180
  ) {
    throw new DomainError('INVALID_DELIVERY_COORDINATES', 'Delivery coordinates are invalid')
  }
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}
