import { describe, expect, it } from 'vitest'

import type { DeliveryEstimate } from '@alo-noon/contracts'

import {
  fareLine,
  formatMoney,
  normalizeIranianMobile,
  normalizeOtpCode,
  productPromiseLabel,
  serviceabilityMessage,
} from './presentation'

describe('customer presentation rules', () => {
  it('normalizes Iranian mobile numbers without persisting display input', () => {
    expect(normalizeIranianMobile('۰۹۱۱ ۱۲۳ ۴۵۶۷')).toBe('+989111234567')
    expect(normalizeIranianMobile('00989111234567')).toBe('+989111234567')
    expect(normalizeIranianMobile('+989111234567')).toBe('+989111234567')
    expect(normalizeIranianMobile('02112345678')).toBeNull()
  })

  it('normalizes a six-digit OTP entered with Persian or Arabic digits', () => {
    expect(normalizeOtpCode('۱۲۳۴۵۶')).toBe('123456')
    expect(normalizeOtpCode('١٢٣ ٤٥٦')).toBe('123456')
    expect(normalizeOtpCode('۱۲۳۴۵')).toBeNull()
  })

  it('formats integer-string money without precision loss', () => {
    expect(formatMoney('90071992547409930000')).toContain('تومان')
    expect(formatMoney('not-money')).toBe('not-money')
  })

  it('reserves fresh-production language for validated signature products', () => {
    expect(
      productPromiseLabel({
        fulfillmentClass: 'SIGNATURE_FRESH',
        freshnessClaim: 'FRESHLY_PRODUCED',
      }),
    ).toContain('تازه')
    expect(
      productPromiseLabel({
        fulfillmentClass: 'PACKAGED_TRADITIONAL',
        freshnessClaim: 'PACKAGED',
      }),
    ).toBe('نان سنتی بسته‌بندی')
    expect(
      productPromiseLabel({
        fulfillmentClass: 'SIGNATURE_FRESH',
        freshnessClaim: 'NONE',
      }),
    ).not.toContain('تازه')
  })

  it('explains suspended service separately from unsupported areas', () => {
    expect(serviceabilityMessage('ZONE_SUSPENDED')).toContain('موقتاً')
    expect(serviceabilityMessage('OUTSIDE_SERVICE_AREA')).toContain('خارج')
  })
})

/**
 * The same three promises the website makes about the same number.
 *
 * A customer who checks the fare on their phone and then on the site must meet
 * one claim, not two. The shared half is the contract's `basis`; these assert
 * that this app reads it the same way `apps/web/src/lib/fare-line` does.
 */
describe('the fare line', () => {
  const estimate = (overrides: Partial<DeliveryEstimate> = {}): DeliveryEstimate => ({
    basis: 'EXACT',
    amount: { amount: '50000', currency: 'IRR' },
    vehicleProfile: 'MOTORCYCLE',
    freeOver: null,
    minimumOrder: null,
    ...overrides,
  })

  it('shows nothing before the shelf has an answer, and nothing when there is no tariff', () => {
    expect(fareLine(undefined)).toBeNull()
    expect(fareLine(null)).toBeNull()
  })

  it('speaks Toman, like every other price in this app', () => {
    expect(fareLine(estimate())?.text).toContain('۵٬۰۰۰')
  })

  it('states a flat tariff as a price and hedges the other two', () => {
    expect(fareLine(estimate({ basis: 'EXACT' }))!.text).not.toContain('حدود')
    expect(fareLine(estimate({ basis: 'FROM' }))!.text).toContain('از')
    expect(fareLine(estimate({ basis: 'INDICATIVE' }))!.text).toContain('حدود')
  })

  it('names the delivery service as the one that decides, when it does', () => {
    expect(fareLine(estimate({ basis: 'INDICATIVE' }))!.note).toContain('سرویس تحویل')
  })

  it('carries free delivery on every basis', () => {
    for (const basis of ['EXACT', 'FROM', 'INDICATIVE'] as const) {
      expect(
        fareLine(estimate({ basis, freeOver: { amount: '800000', currency: 'IRR' } }))!.freeOver,
      ).toContain('رایگان')
    }
  })
})
