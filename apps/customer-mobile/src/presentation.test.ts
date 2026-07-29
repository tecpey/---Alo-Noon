import { describe, expect, it } from 'vitest'

import {
  formatRials,
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
    expect(formatRials('90071992547409930000')).toContain('ریال')
    expect(formatRials('not-money')).toBe('not-money')
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
