import { describe, expect, it } from 'vitest'

import { localNowIn, serviceDateValue, zonedTimeToUtc } from './modules/city-clock.js'

const TEHRAN = 'Asia/Tehran'

describe('localNowIn', () => {
  it('reads the city clock, not the server clock', () => {
    // 03:00 UTC is 06:30 in Tehran.
    expect(localNowIn(new Date('2026-06-03T03:00:00.000Z'), TEHRAN)).toEqual({
      serviceDate: '2026-06-03',
      minuteOfDay: 6 * 60 + 30,
      dayOfWeek: 3,
    })
  })

  /**
   * The case that broke capacity once already: from half past eight at night
   * UTC it is tomorrow in Tehran, and a service date read off the instant sends
   * every evening order to a day that has no capacity.
   */
  it('is already tomorrow in Tehran while UTC is still today', () => {
    expect(localNowIn(new Date('2026-06-03T20:31:00.000Z'), TEHRAN)).toEqual({
      serviceDate: '2026-06-04',
      minuteOfDay: 1,
      dayOfWeek: 4,
    })
  })

  it('takes the weekday from the local day, not the UTC one', () => {
    // Saturday night UTC, already Sunday in Tehran.
    expect(localNowIn(new Date('2026-06-06T21:00:00.000Z'), TEHRAN).dayOfWeek).toBe(0)
  })
})

describe('zonedTimeToUtc', () => {
  it('turns a local window start into the instant it happens', () => {
    // 07:00 in Tehran is 03:30 UTC.
    expect(zonedTimeToUtc('2026-06-03', 7 * 60, TEHRAN).toISOString()).toBe(
      '2026-06-03T03:30:00.000Z',
    )
  })

  it('round-trips against localNowIn', () => {
    const instant = zonedTimeToUtc('2026-11-21', 18 * 60 + 45, TEHRAN)
    expect(localNowIn(instant, TEHRAN)).toEqual({
      serviceDate: '2026-11-21',
      minuteOfDay: 18 * 60 + 45,
      dayOfWeek: 6,
    })
  })

  it('handles local midnight', () => {
    expect(zonedTimeToUtc('2026-06-03', 0, TEHRAN).toISOString()).toBe('2026-06-02T20:30:00.000Z')
  })

  /**
   * Iran has not shifted its clocks since 2022, so this is not Tehran's problem
   * today — but the conversion has to be right for the day the platform serves
   * a zone that does, and a fixed offset would be an hour out twice a year.
   */
  it('follows a zone across a daylight saving boundary', () => {
    // Europe/Berlin moves to summer time at 02:00 local on 2026-03-29.
    expect(zonedTimeToUtc('2026-03-28', 12 * 60, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T11:00:00.000Z',
    )
    expect(zonedTimeToUtc('2026-03-30', 12 * 60, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-30T10:00:00.000Z',
    )
  })
})

describe('serviceDateValue', () => {
  it('matches the midnight-UTC shape a date column stores', () => {
    expect(serviceDateValue('2026-06-03').toISOString()).toBe('2026-06-03T00:00:00.000Z')
  })
})
