import { describe, expect, it } from 'vitest'

import { formatDeliveryWindow, formatWindowDay } from './delivery-window-label'

// Tuesday 2026-06-02, 03:00 UTC — half past six in the morning in Tehran.
const now = new Date('2026-06-02T03:00:00.000Z')

describe('formatDeliveryWindow', () => {
  it('names today in the words a customer would use', () => {
    expect(formatDeliveryWindow('2026-06-02T04:30:00.000Z', '2026-06-02T06:30:00.000Z', now)).toBe(
      'امروز ۸ تا ۱۰',
    )
  })

  it('names tomorrow', () => {
    expect(formatDeliveryWindow('2026-06-03T02:30:00.000Z', '2026-06-03T04:30:00.000Z', now)).toBe(
      'فردا ۶ تا ۸',
    )
  })

  /**
   * Past tomorrow the day is named outright. "پس‌فردا" is a word people
   * disagree about often enough that a bakery should not schedule an oven on it.
   */
  it('names the day outright once the relative words run out', () => {
    const label = formatDeliveryWindow('2026-06-04T02:30:00.000Z', '2026-06-04T04:30:00.000Z', now)
    expect(label).not.toContain('فردا')
    expect(label).toContain('۶ تا ۸')
  })

  /**
   * The case a UTC comparison gets wrong: at half past eleven at night in
   * Tehran it is already tomorrow locally but still today in UTC, and the
   * first window of the morning would be labelled "امروز".
   */
  it('reads the day in Tehran, not in UTC', () => {
    const lateEvening = new Date('2026-06-02T20:45:00.000Z') // 00:15 on the 3rd, locally
    expect(formatWindowDay('2026-06-03T02:30:00.000Z', lateEvening)).toBe('امروز')
    expect(formatWindowDay('2026-06-04T02:30:00.000Z', lateEvening)).toBe('فردا')
  })

  it('writes hours in Persian digits on a 24-hour clock', () => {
    expect(formatDeliveryWindow('2026-06-02T12:30:00.000Z', '2026-06-02T14:30:00.000Z', now)).toBe(
      'امروز ۱۶ تا ۱۸',
    )
  })
})
