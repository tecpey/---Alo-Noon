import { describe, expect, it } from 'vitest'

import { formatToman, groupDigits, sumRial, toPersianDigits } from './persian'

describe('persian number presentation', () => {
  it('shows a price in Toman from an amount held in Rial', () => {
    expect(formatToman('280000')).toBe('۲۸٬۰۰۰ تومان')
  })

  it('never parses money into a number', () => {
    // Beyond Number.MAX_SAFE_INTEGER. A yearly total that quietly rounded would
    // still look like a number somebody could act on.
    expect(formatToman('99999999999999999990')).toBe('۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹ تومان')
  })

  it('refuses a Rial amount that is not a whole Toman', () => {
    // Dropping the last digit would turn a pricing fault into a plausible price.
    expect(formatToman('12345')).toBe('—')
  })

  it('groups long digit strings from the right', () => {
    expect(groupDigits('1234567')).toBe('1٬234٬567')
  })

  it('converts digits without touching anything else', () => {
    expect(toPersianDigits('۱۸:۰۰ – 19:30')).toBe('۱۸:۰۰ – ۱۹:۳۰')
  })
})

describe('adding up a basket', () => {
  it('multiplies and sums without leaving integers', () => {
    expect(
      sumRial([
        { priceRial: '280000', quantity: 2 },
        { priceRial: '95000', quantity: 1 },
        { priceRial: '60000', quantity: 1 },
      ]),
    ).toBe('715000')
  })

  it('stays exact past the float-safe range', () => {
    // A month of a working city. A total that quietly rounded here would still
    // look like a number somebody could reconcile against.
    expect(sumRial([{ priceRial: '9007199254740993', quantity: 3 }])).toBe('27021597764222979')
  })

  it('ignores a line with a nonsense price rather than throwing', () => {
    // One bad row must not take the whole basket down with it.
    expect(
      sumRial([
        { priceRial: 'abc', quantity: 2 },
        { priceRial: '5000', quantity: 1 },
      ]),
    ).toBe('5000')
  })

  it('treats a negative quantity as none', () => {
    expect(sumRial([{ priceRial: '5000', quantity: -3 }])).toBe('0')
  })
})
