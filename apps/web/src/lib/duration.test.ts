import { describe, expect, it } from 'vitest'

import { minutes } from './duration'

/**
 * These numbers say how long bread stays good. Every case here is about the
 * direction the rounding goes, because being wrong upwards tells a customer
 * their food is safe for longer than the bakery said it was.
 */
describe('minutes', () => {
  it('never rounds a freshness window upwards', () => {
    expect(minutes(90)).toBe('۹۰ دقیقه')
    expect(minutes(119)).toBe('۱۱۹ دقیقه')
    expect(minutes(150)).toBe('۲ ساعت')
    expect(minutes(1_439)).toBe('۲۳ ساعت')
  })

  it('stays in minutes until hours are worth using', () => {
    expect(minutes(30)).toBe('۳۰ دقیقه')
    expect(minutes(120)).toBe('۲ ساعت')
  })

  it('reaches days only past two of them', () => {
    expect(minutes(1_440)).toBe('۲۴ ساعت')
    expect(minutes(2_880)).toBe('۲ روز')
    expect(minutes(4_320)).toBe('۳ روز')
  })
})
