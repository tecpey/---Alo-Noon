import { describe, expect, it } from 'vitest'

import type { DeliveryEstimate } from '@alo-noon/contracts'

import { fareLine } from './fare-line'

function estimate(overrides: Partial<DeliveryEstimate> = {}): DeliveryEstimate {
  return {
    basis: 'EXACT',
    amount: { amount: '50000', currency: 'IRR' },
    vehicleProfile: 'MOTORCYCLE',
    freeOver: null,
    minimumOrder: null,
    ...overrides,
  }
}

/**
 * The wording is the feature.
 *
 * The number was always knowable; what makes showing it early an improvement
 * rather than a new way to mislead is that each `basis` gets a sentence the
 * shop can keep. These assert the distinctions rather than the exact prose, so
 * the copy can be rewritten without the promises drifting.
 */
describe('the fare line', () => {
  it('shows nothing when no tariff is published', () => {
    // Not an empty string and not «رایگان» — no line at all.
    expect(fareLine(null)).toBeNull()
  })

  it('converts to Toman, because Rial appears nowhere a customer reads', () => {
    expect(fareLine(estimate())?.text).toContain('۵٬۰۰۰')
  })

  it('states a flat tariff as a price, with no hedge', () => {
    const line = fareLine(estimate({ basis: 'EXACT' }))!
    expect(line.text).not.toContain('از ')
    expect(line.text).not.toContain('حدود')
  })

  it('marks a distance tariff as a floor', () => {
    const line = fareLine(estimate({ basis: 'FROM' }))!
    expect(line.text).toContain('از')
    expect(line.note).toContain('مسافت')
    // And the vehicle, because on the launch tenant that is the reason: the
    // motorcycle tariff is flat and only choosing the car costs more.
    expect(line.note).toContain('وسیله')
  })

  it('says who decides when a provider will quote', () => {
    // The number is the shop's own tariff, but the provider has the last word,
    // so the line may not read as a price and the note must name the reason.
    const line = fareLine(estimate({ basis: 'INDICATIVE' }))!
    expect(line.text).toContain('حدود')
    expect(line.note).toContain('سرویس تحویل')
  })

  it('never states a provider-quoted fare as flatly as a fixed one', () => {
    const fixed = fareLine(estimate({ basis: 'EXACT' }))!
    const quoted = fareLine(estimate({ basis: 'INDICATIVE' }))!
    expect(quoted.text).not.toBe(fixed.text)
  })

  it('carries the free-delivery offer alongside, on every basis', () => {
    for (const basis of ['EXACT', 'FROM', 'INDICATIVE'] as const) {
      const line = fareLine(estimate({ basis, freeOver: { amount: '800000', currency: 'IRR' } }))!
      expect(line.freeOver).toContain('۸۰٬۰۰۰')
      expect(line.freeOver).toContain('رایگان')
    }
  })
})
