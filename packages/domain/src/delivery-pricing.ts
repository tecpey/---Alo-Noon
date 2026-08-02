import { DomainError } from './errors'

export type DeliveryPricingMode = 'FLAT' | 'DISTANCE_BANDED'

export interface DeliveryPricingRuleCandidate {
  id: string
  operationalZoneId: string | null
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

export function selectDeliveryPricingRule(
  rules: readonly DeliveryPricingRuleCandidate[],
  operationalZoneId: string,
): Readonly<DeliveryPricingRuleCandidate> {
  const zoneRules = rules.filter((rule) => rule.operationalZoneId === operationalZoneId)
  const candidates =
    zoneRules.length > 0 ? zoneRules : rules.filter((rule) => rule.operationalZoneId === null)
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
