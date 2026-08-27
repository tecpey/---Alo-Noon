import { describe, expect, it } from 'vitest'

import { normalizeMobile, normalizeOtpCode, toLatinDigits } from './shop-format'

describe('the mobile number a customer actually types', () => {
  it('accepts every spelling of the same number', () => {
    // All five of these are one number. Accepting one and refusing the rest is
    // refusing customers over a formatting preference, in the first field they
    // ever fill in.
    for (const typed of [
      '09121234567',
      '+989121234567',
      '989121234567',
      '0912 123 4567',
      '0912-123-4567',
    ]) {
      expect(normalizeMobile(typed)).toBe('+989121234567')
    }
  })

  it('accepts Persian digits, which is how a Persian keyboard types', () => {
    expect(normalizeMobile('۰۹۱۲۱۲۳۴۵۶۷')).toBe('+989121234567')
  })

  it('refuses what is not an Iranian mobile number', () => {
    // A landline, a number too short, a number too long, and nothing at all.
    for (const typed of ['02112345678', '0912123456', '091212345678', '', 'سلام']) {
      expect(normalizeMobile(typed)).toBeNull()
    }
  })
})

describe('the one-time code', () => {
  it('takes the digits and drops everything else', () => {
    expect(normalizeOtpCode('۱۲۳ ۴۵۶')).toBe('123456')
  })

  it('never grows past what the API will read', () => {
    expect(normalizeOtpCode('12345678901234')).toHaveLength(8)
  })
})

describe('digit conversion', () => {
  it('handles both Persian and Arabic-Indic forms', () => {
    expect(toLatinDigits('۱۲۳')).toBe('123')
    expect(toLatinDigits('١٢٣')).toBe('123')
  })
})
