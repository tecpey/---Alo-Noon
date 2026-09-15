import { describe, expect, it } from 'vitest'

import {
  calculateDeliveryDistanceMeters,
  calculateDeliveryFee,
  selectDeliveryPricingRule,
  type DeliveryPricingRuleCandidate,
} from './delivery-pricing'

function rule(overrides: Partial<DeliveryPricingRuleCandidate> = {}): DeliveryPricingRuleCandidate {
  return {
    id: 'city-rule',
    operationalZoneId: null,
    vehicleProfile: 'MOTORCYCLE',
    version: 1,
    mode: 'FLAT',
    baseFeeAmount: 50_000n,
    perKmFeeAmount: null,
    minimumOrderAmount: null,
    freeDeliveryThresholdAmount: null,
    currency: 'IRR',
    ...overrides,
  }
}

describe('delivery pricing', () => {
  it('applies a flat fee', () => {
    expect(calculateDeliveryFee(rule(), 500_000n, 1_250).deliveryFeeAmount).toBe(50_000n)
  })

  it('bills each started kilometer deterministically', () => {
    const distanceRule = rule({ mode: 'DISTANCE_BANDED', perKmFeeAmount: 10_000n })
    expect(calculateDeliveryFee(distanceRule, 500_000n, 1_000).deliveryFeeAmount).toBe(60_000n)
    expect(calculateDeliveryFee(distanceRule, 500_000n, 1_001).deliveryFeeAmount).toBe(70_000n)
  })

  it('calculates a stable integer-meter great-circle distance', () => {
    expect(
      calculateDeliveryDistanceMeters(
        { latitude: 36.5387, longitude: 52.6765 },
        { latitude: 36.5487, longitude: 52.6765 },
      ),
    ).toBe(1_112)
  })

  it('applies free delivery and enforces the minimum order', () => {
    expect(
      calculateDeliveryFee(rule({ freeDeliveryThresholdAmount: 500_000n }), 500_000n, 100)
        .deliveryFeeAmount,
    ).toBe(0n)
    expect(() =>
      calculateDeliveryFee(rule({ minimumOrderAmount: 200_000n }), 199_999n, 100),
    ).toThrow(expect.objectContaining({ code: 'MINIMUM_ORDER_NOT_MET' }))
  })

  it('prefers a zone rule and otherwise uses the city fallback', () => {
    expect(
      selectDeliveryPricingRule(
        [rule(), rule({ id: 'zone-rule', operationalZoneId: 'zone-a' })],
        'zone-a',
      ).id,
    ).toBe('zone-rule')
    expect(selectDeliveryPricingRule([rule()], 'zone-a').id).toBe('city-rule')
  })

  it.each([
    [[], 'DELIVERY_PRICING_RULE_MISSING'],
    [[rule(), rule({ id: 'duplicate' })], 'DELIVERY_PRICING_RULE_AMBIGUOUS'],
  ])('fails closed when selection is invalid', (rules, code) => {
    expect(() => selectDeliveryPricingRule(rules, 'zone-a')).toThrow(
      expect.objectContaining({ code }),
    )
  })
})

/*
 * Choosing a tariff once there are two vehicles.
 *
 * A car is a separate rate, not a surcharge, so picking the wrong one is not a
 * rounding error — it is charging a motorcycle call-out for a car journey, on
 * exactly the largest and longest orders the bakery takes.
 */
describe('choosing a tariff for the vehicle the order needs', () => {
  const motorcycleCity = rule({ id: 'moto-city', vehicleProfile: 'MOTORCYCLE' })
  const carCity = rule({ id: 'car-city', vehicleProfile: 'CAR', baseFeeAmount: 150_000n })
  const motorcycleZone = rule({
    id: 'moto-zone',
    vehicleProfile: 'MOTORCYCLE',
    operationalZoneId: 'zone-a',
  })

  it('picks the car tariff when the order needs a car', () => {
    expect(selectDeliveryPricingRule([motorcycleCity, carCity], 'zone-a', 'CAR').id).toBe(
      'car-city',
    )
  })

  it('picks the motorcycle tariff when it does not', () => {
    expect(selectDeliveryPricingRule([motorcycleCity, carCity], 'zone-a', 'MOTORCYCLE').id).toBe(
      'moto-city',
    )
  })

  it('never substitutes a zone’s motorcycle rate for a missing car rate', () => {
    // The trap this ordering exists to avoid. Narrowing by zone first would
    // find the zone's motorcycle tariff, see exactly one candidate, and price a
    // car journey at motorcycle rates without anything looking wrong. Narrowing
    // by vehicle first makes the absence visible instead.
    expect(() => selectDeliveryPricingRule([motorcycleZone], 'zone-a', 'CAR')).toThrow(
      expect.objectContaining({ code: 'DELIVERY_VEHICLE_TARIFF_MISSING' }),
    )
  })

  it('falls back from a zone to the city, but only within the same vehicle', () => {
    // A city-wide car rate is a reasonable stand-in for a zone that has not set
    // its own. A zone's motorcycle rate never is.
    expect(selectDeliveryPricingRule([carCity, motorcycleZone], 'zone-a', 'CAR').id).toBe(
      'car-city',
    )
  })

  it('prefers a zone’s own car rate over the city’s', () => {
    const carZone = rule({ id: 'car-zone', vehicleProfile: 'CAR', operationalZoneId: 'zone-a' })
    expect(selectDeliveryPricingRule([carCity, carZone], 'zone-a', 'CAR').id).toBe('car-zone')
  })

  it('still refuses two tariffs for the same vehicle and scope', () => {
    // The ambiguity guard must survive the new dimension: two active car rates
    // for one zone is a configuration error, not a choice to make silently.
    const duplicate = rule({ id: 'car-city-2', vehicleProfile: 'CAR' })
    expect(() => selectDeliveryPricingRule([carCity, duplicate], 'zone-a', 'CAR')).toThrow(
      expect.objectContaining({ code: 'DELIVERY_PRICING_RULE_AMBIGUOUS' }),
    )
  })

  it('says pricing is missing, not that the car rate is, when nothing is configured', () => {
    // The two are different jobs for whoever reads the error: set this city up,
    // against publish a car rate for a city that is otherwise working.
    expect(() => selectDeliveryPricingRule([], 'zone-a', 'CAR')).toThrow(
      expect.objectContaining({ code: 'DELIVERY_PRICING_RULE_MISSING' }),
    )
  })

  it('defaults to the motorcycle tariff when no vehicle is named', () => {
    // Every caller that predates the vehicle was pricing a motorcycle, so the
    // default keeps them correct rather than merely compiling.
    expect(selectDeliveryPricingRule([motorcycleCity, carCity], 'zone-a').id).toBe('moto-city')
  })
})
