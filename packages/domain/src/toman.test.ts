import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  formatToman,
  formatTomanExact,
  groupDigits,
  parseTomanToRial,
  rialToToman,
  tomanDigits,
  tomanExactDigits,
} from './toman'

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

describe('the number without its unit', () => {
  /**
   * Two functions on purpose, and this is the pair they exist for.
   *
   * A sentence this code writes needs the word «تومان» attached. A message
   * template an operator wrote already contains the word, so substituting the
   * phrase would render «۵۰٬۰۰۰ تومان تومان» into a text message somebody is
   * about to act on.
   */
  it('gives the grouped Persian digits and nothing else', () => {
    expect(tomanDigits(500_000n)).toBe('۵۰٬۰۰۰')
    expect(tomanDigits(1_850_000n)).toBe('۱۸۵٬۰۰۰')
    expect(tomanDigits(0n)).toBe('۰')
    expect(tomanDigits(500_000n)).not.toContain('تومان')
  })

  it('is exactly what formatToman prints, minus the unit', () => {
    expect(formatToman(1_850_000n)).toBe(`${tomanDigits(1_850_000n)} تومان`)
  })

  it('refuses an amount that is not a whole Toman, like every other conversion', () => {
    // A stray Rial is a pricing fault. Rounding it here would hide the fault
    // behind a plausible number, in a text message about money.
    expect(() => tomanDigits(1_850_005n)).toThrow(DomainError)
  })
})

describe('showing a derived amount, remainder and all', () => {
  /**
   * The strict conversion is right for a price and wrong for a commission.
   *
   * A commission is `subtotal × basisPoints ÷ 10000`. A 250,000 Rial subtotal
   * at 3.33٪ is 8,325 Rial — 832٫5 Toman — and so is the bakery's share of the
   * same order. Refusing those does not protect a report, it blanks one.
   */
  it('keeps the half Toman a basis-point rate produces', () => {
    expect(tomanExactDigits(8_325n)).toBe('832٫5')
    expect(tomanExactDigits(2_416_755n)).toBe('241٬675٫5')
    expect(formatTomanExact(8_325n)).toBe('۸۳۲٫۵ تومان')
  })

  /** Ten Rial to the Toman, so halves are the only fraction that can exist. */
  it('never prints more than one decimal place', () => {
    for (const rial of [1n, 5n, 9n, 99n, 8_325n, 90_071_992_547_409_939n]) {
      const [, fraction] = tomanExactDigits(rial).split('٫')
      expect(fraction).toHaveLength(1)
    }
  })

  it('renders an amount below one Toman rather than losing it', () => {
    expect(tomanExactDigits(5n)).toBe('0٫5')
    expect(tomanExactDigits(0n)).toBe('0')
  })

  /**
   * The two conversions must never disagree about the same number, or an
   * operator comparing a report against a customer's screen sees two prices.
   */
  it('agrees with the strict conversion wherever the strict one answers', () => {
    for (const rial of [0n, 10n, 500_000n, 1_850_000n, 90_071_992_547_409_930n]) {
      expect(tomanExactDigits(rial)).toBe(groupDigits(rialToToman(rial)))
      expect(formatTomanExact(rial)).toBe(formatToman(rial))
    }
  })

  it('stays exact past the float-safe range, like everything else here', () => {
    expect(tomanExactDigits(90_071_992_547_409_935n)).toBe('9٬007٬199٬254٬740٬993٫5')
  })

  it('still refuses a negative amount', () => {
    // Sign is the caller's to render; a magnitude formatter that silently
    // absorbed one would print a debt as a credit.
    expect(() => tomanExactDigits(-10n)).toThrow(DomainError)
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
