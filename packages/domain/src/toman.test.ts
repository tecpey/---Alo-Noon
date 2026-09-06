import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { formatToman, groupDigits, parseTomanToRial, rialToToman } from './toman'

describe('showing Rial as Toman', () => {
  it('shifts a digit rather than dividing', () => {
    expect(rialToToman(100_000n)).toBe('10000')
    expect(rialToToman(0n)).toBe('0')
    expect(rialToToman(10n)).toBe('1')
  })

  /** A basket of bread will not reach here, but a month of orders will. */
  it('stays exact past the float-safe range', () => {
    expect(rialToToman(90_071_992_547_409_930n)).toBe('9007199254740993')
  })

  it('writes a phrase somebody can read', () => {
    expect(formatToman(1_850_000n)).toBe('۱۸۵٬۰۰۰ تومان')
    expect(formatToman(0n)).toBe('۰ تومان')
  })

  /**
   * A Rial amount that is not a whole Toman is a pricing fault. Rounding it
   * would hide the fault behind a plausible number, and the number is money.
   */
  it('refuses an amount that is not a whole Toman', () => {
    expect(() => rialToToman(1_234n)).toThrow(DomainError)
    expect(() => rialToToman(-10n)).toThrow(DomainError)
  })

  it('groups from the right, however long', () => {
    expect(groupDigits('1')).toBe('1')
    expect(groupDigits('1234567')).toBe('1٬234٬567')
    expect(groupDigits('000')).toBe('0')
  })
})

describe('reading Toman as typed', () => {
  it('accepts the digits and separators people actually use', () => {
    expect(parseTomanToRial('50000')).toBe(500_000n)
    expect(parseTomanToRial('۵۰٬۰۰۰')).toBe(500_000n)
    expect(parseTomanToRial('50,000')).toBe(500_000n)
    expect(parseTomanToRial(' ۵۰ ۰۰۰ ')).toBe(500_000n)
    expect(parseTomanToRial('٥٠٠٠٠')).toBe(500_000n)
  })

  it('answers with null rather than throwing, because a form asked', () => {
    expect(parseTomanToRial('')).toBeNull()
    expect(parseTomanToRial('abc')).toBeNull()
    expect(parseTomanToRial('-5000')).toBeNull()
    expect(parseTomanToRial('0')).toBeNull()
    expect(parseTomanToRial('12.5')).toBeNull()
  })
})
