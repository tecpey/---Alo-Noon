import { touch } from '@alo-noon/design-tokens'
import { describe, expect, it } from 'vitest'

import { hitSlopTo } from './hit-slop'

/**
 * The arithmetic behind the one mechanism that enlarges a target without
 * enlarging the layout.
 *
 * Worth a test because it is easy to get subtly wrong in a way nothing shows:
 * a hit slop that is half the shortfall rather than half on *each side* leaves
 * the control still under the floor, and it looks identical either way.
 */
describe('reaching past a control that cannot grow', () => {
  it('adds enough on both sides to clear the floor', () => {
    const slop = hitSlopTo(18)
    // 18 drawn, plus the slop above and below.
    expect(18 + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.minPoints)
  })

  it('rounds up, so an odd shortfall lands on the floor rather than under it', () => {
    // 44 − 17 = 27, which halves to 13.5. Rounding down would give 43.
    const slop = hitSlopTo(17)
    expect(slop.top).toBe(14)
    expect(17 + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.minPoints)
  })

  it('asks for nothing when the control is already big enough', () => {
    // A negative hit slop shrinks the touchable area, which would make a
    // comfortable button harder to press than a cramped one.
    for (const height of [touch.minPoints, touch.comfortablePoints, 96]) {
      const slop = hitSlopTo(height)
      expect(`${height}: ${slop.top}`).toBe(`${height}: 0`)
    }
  })
})
