import { describe, expect, it } from 'vitest'

import { parseRialAmount, parseTomanAmount } from './amounts'

describe('parsing a gateway-reported Rial amount', () => {
  it.each([
    ['2950000', 2_950_000n],
    [2_950_000, 2_950_000n],
    ['  2950000  ', 2_950_000n],
    ['0', 0n],
  ])('reads %s', (input, expected) => {
    expect(parseRialAmount(input)).toBe(expected)
  })

  it('keeps a figure beyond the float-safe range exact', () => {
    expect(parseRialAmount('9007199254740993')).toBe(9_007_199_254_740_993n)
  })

  it.each([
    ['a negative amount', '-100'],
    ['a decimal amount', '2950000.00'],
    ['a thousands-separated amount', '2,950,000'],
    ['a Persian-digit amount', '۲۹۵۰۰۰۰'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-numeric string', 'IRR2950000'],
    ['a value too long to be real', '1'.repeat(19)],
    ['undefined', undefined],
    ['null', null],
  ])('refuses %s rather than guessing', (_label, input) => {
    // A guess that happens to equal the expected amount would authorise a
    // capture on no evidence, so anything ambiguous must read as unknown.
    expect(parseRialAmount(input)).toBeNull()
  })

  it('refuses a float that lost precision before reaching us', () => {
    expect(parseRialAmount(2_950_000.5)).toBeNull()
  })
})

describe('parsing a gateway-reported Toman amount', () => {
  it('converts to IRR minor units', () => {
    expect(parseTomanAmount('295000')).toBe(2_950_000n)
    expect(parseTomanAmount(295_000)).toBe(2_950_000n)
  })

  it('never returns an amount that is not a multiple of ten', () => {
    const converted = parseTomanAmount('12345')
    expect(converted).toBe(123_450n)
    expect(converted! % 10n).toBe(0n)
  })

  it.each([['-1'], ['1.5'], [''], ['abc'], ['1'.repeat(18)]])(
    'refuses %s rather than guessing',
    (input) => {
      expect(parseTomanAmount(input)).toBeNull()
    },
  )
})
