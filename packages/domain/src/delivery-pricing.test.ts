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
