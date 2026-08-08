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
    expect(formatMoney({ amount: '27021597769222984', currency: 'IRR' })).toContain('۲۷')
  })

  it.each([
    ['0', '۰ ریال'],
    ['7', '۷ ریال'],
    ['250000', '۲۵۰٬۰۰۰ ریال'],
    ['1000000', '۱٬۰۰۰٬۰۰۰ ریال'],
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
})

describe('count and percent formatting', () => {
  it('groups counts and renders them in Persian digits', () => {
    expect(formatCount(0)).toBe('۰')
    expect(formatCount(12_345)).toBe('۱۲٬۳۴۵')
  })

  it('renders a rate as a percentage and a missing one as a dash', () => {
    expect(formatPercent(0.4218)).toBe('۴۲.۲٪')
    expect(formatPercent(1)).toBe('۱۰۰.۰٪')
    expect(formatPercent(null)).toBe('—')
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
    expect(formatSignedMoney({ amount: '-250000', currency: 'IRR' })).toContain('−')
    expect(formatSignedMoney({ amount: '250000', currency: 'IRR' })).not.toContain('−')
    // A gap of zero is neither a surplus nor a shortfall.
    expect(formatSignedMoney({ amount: '0', currency: 'IRR' })).toBe('۰ ریال')
  })
})
