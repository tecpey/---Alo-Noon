import { describe, expect, it } from 'vitest'

import {
  formatSignedMoney,
  formatCount,
  formatDate,
  formatMoney,
  formatPercent,
  groupDigits,
  label,
  ORDER_STATE_LABELS,
  recentRange,
} from './admin-format-display'

describe('money formatting', () => {
  it('keeps a figure beyond the float-safe range exact', () => {
    // The whole reason money is a string: parsing this would lose the last digit.
    expect(groupDigits('27021597769222984')).toBe('27٬021٬597٬769٬222٬984')
    // The last digit survives the conversion, which a float would have eaten.
    expect(formatMoney({ amount: '27021597769222980', currency: 'IRR' })).toBe(
      '۲٬۷۰۲٬۱۵۹٬۷۷۶٬۹۲۲٬۲۹۸ تومان',
    )
  })

  /**
   * Toman, like every other number anybody in this system reads.
   *
   * The panel printed Rial while the storefront, both applications and every
   * text message printed Toman, so an operator comparing a report against a
   * customer's screen was reading the same money ten times over.
   */
  it.each([
    ['0', '۰ تومان'],
    ['70', '۷ تومان'],
    ['2500000', '۲۵۰٬۰۰۰ تومان'],
    ['10000000', '۱٬۰۰۰٬۰۰۰ تومان'],
  ])('renders %s as %s', (amount, expected) => {
    expect(formatMoney({ amount, currency: 'IRR' })).toBe(expected)
  })

  it('normalises leading zeros rather than printing them', () => {
    expect(groupDigits('000250000')).toBe('250٬000')
    // Latin throughout: the Persian conversion happens once, in the caller.
    expect(groupDigits('0')).toBe('0')
    expect(groupDigits('')).toBe('0')
  })

  it('renders a missing amount as a dash instead of zero', () => {
    // Zero revenue and "we could not read revenue" must not look identical.
    expect(formatMoney(undefined)).toBe('—')
  })

  /**
   * The half Toman that a commission rate produces.
   *
   * A 250,000 Rial subtotal at 3.33٪ is 8,325 Rial — 832٫5 Toman — and so is
   * the bakery's share of the same order, and every column that sums either.
   * The strict conversion refuses those, which on a report means a dash where a
   * number belongs; a settlement page that stops reporting looks exactly like a
   * settlement page with nothing to report.
   */
  it.each([
    ['8325', '۸۳۲٫۵ تومان'],
    ['2416750', '۲۴۱٬۶۷۵ تومان'],
    ['2416755', '۲۴۱٬۶۷۵٫۵ تومان'],
    ['5', '۰٫۵ تومان'],
  ])('keeps the half Toman in a derived figure: %s', (amount, expected) => {
    expect(formatMoney({ amount, currency: 'IRR' })).toBe(expected)
  })

  it('never drops a minus sign', () => {
    // A debt printed as a credit is worse than no number at all, and both
    // helpers reach the trial balance.
    expect(formatMoney({ amount: '-2500000', currency: 'IRR' })).toBe('−۲۵۰٬۰۰۰ تومان')
    expect(formatSignedMoney({ amount: '-8325', currency: 'IRR' })).toBe('−۸۳۲٫۵ تومان')
    expect(formatSignedMoney({ amount: '2500000', currency: 'IRR' })).toBe('۲۵۰٬۰۰۰ تومان')
  })

  it('still draws a dash for an amount it cannot read', () => {
    expect(formatMoney({ amount: 'NaN', currency: 'IRR' })).toBe('—')
    expect(formatSignedMoney({ amount: '-', currency: 'IRR' })).toBe('—')
  })
})

describe('count and percent formatting', () => {
  it('groups counts and renders them in Persian digits', () => {
    expect(formatCount(0)).toBe('۰')
    expect(formatCount(12_345)).toBe('۱۲٬۳۴۵')
  })

  it('renders a rate as a percentage and a missing one as a dash', () => {
    // The Persian decimal separator, the same one the money column uses: one
    // table with two different decimal marks reads as two different tables.
    expect(formatPercent(0.4218)).toBe('۴۲٫۲٪')
    expect(formatPercent(1)).toBe('۱۰۰٫۰٪')
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0.4218)).not.toContain('.')
  })
})

describe('date formatting', () => {
  it('renders a daily bucket as a Jalali date, without shifting it a day', () => {
    // fa-IR renders the Jalali calendar, which is what a Persian operator reads.
    // The bucket is already a calendar date in the reporting zone, so it is
    // anchored at midday before projection — anchoring at UTC midnight would
    // move it back a day for Tehran.
    expect(formatDate('2026-03-02')).toBe('۱۱ اسفند')
    expect(formatDate('2026-03-03')).toBe('۱۲ اسفند')
    // Consecutive days stay consecutive; no boundary collapses two into one.
    expect(formatDate('2026-03-02')).not.toBe(formatDate('2026-03-03'))
  })

  it('passes through a value that is not a date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
})

describe('reporting range', () => {
  it('produces a closed-open range covering the requested days', () => {
    const now = new Date('2026-03-10T12:00:00.000Z')
    const range = recentRange(7, now)
    const span = new Date(range.to).getTime() - new Date(range.from).getTime()
    expect(span).toBe(7 * 86_400_000)
    // `to` is nudged past now so an order placed this second is still counted.
    expect(new Date(range.to).getTime()).toBeGreaterThan(now.getTime())
  })
})

describe('state labels', () => {
  it('translates a known state', () => {
    expect(label(ORDER_STATE_LABELS, 'CONFIRMED')).toBe('تأییدشده')
  })

  it('shows an unknown state verbatim rather than hiding a schema change', () => {
    expect(label(ORDER_STATE_LABELS, 'SOME_NEW_STATE')).toBe('SOME_NEW_STATE')
  })

  it('keeps the sign on money that may legitimately be negative', () => {
    expect(formatSignedMoney({ amount: '-2500000', currency: 'IRR' })).toContain('−')
    expect(formatSignedMoney({ amount: '2500000', currency: 'IRR' })).not.toContain('−')
    // A gap of zero is neither a surplus nor a shortfall.
    expect(formatSignedMoney({ amount: '0', currency: 'IRR' })).toBe('۰ تومان')
  })
})
