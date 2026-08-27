import { describe, expect, it } from 'vitest'

import { formatToman, groupDigits, toPersianDigits } from './persian'

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
