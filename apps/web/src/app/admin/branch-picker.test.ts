import { describe, expect, it } from 'vitest'

import { branchHint } from '../../lib/admin-format-display'

/**
 * What the branch picker tells an operator about itself.
 *
 * The listing is bounded now — a national tenant has thousands of branches and
 * a dropdown holding all of them is a wall rather than a list, worst on the
 * phone somebody is holding in a bakery. Bounding it introduces a new way to
 * mislead: a select quietly showing the first twenty of six hundred is a select
 * an operator scrolls to the bottom of before concluding the branch was never
 * registered.
 *
 * So the hint is the feature, and it is checked.
 */
describe('what the branch picker says about itself', () => {
  it('says a truncated list is truncated, and how to see the rest', () => {
    const hint = branchHint(20, 340, '')
    expect(hint).toContain('۲۰')
    expect(hint).toContain('۳۴۰')
    // Not just that it is short — what to do about it.
    expect(hint).toContain('جست‌وجو')
  })

  it('counts in Persian, like every other number on the page', () => {
    expect(branchHint(20, 340, '')).not.toMatch(/[0-9]/)
  })

  it('does not cry truncation when the list is the whole answer', () => {
    // The common case today: a pilot city with a handful of branches, where
    // the native select is the best control there is and needs no explaining.
    expect(branchHint(6, 6, '')).not.toContain('جست‌وجو')
    expect(branchHint(6, 6, '')).toContain('همین شعبه')
  })

  it('tells an empty search apart from an empty tenant', () => {
    // «Nothing matched what you typed» and «no branch has ever been registered»
    // are different problems with different fixes, and a shared sentence sends
    // somebody to look in the wrong place.
    expect(branchHint(0, 0, 'نانوایی رضا')).toContain('پیدا نشد')
    expect(branchHint(0, 0, '')).toContain('ثبت نشده')
    expect(branchHint(0, 0, 'نانوایی رضا')).not.toBe(branchHint(0, 0, ''))
  })
})
