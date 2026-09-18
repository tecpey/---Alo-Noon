import { describe, expect, it } from 'vitest'

import { foldPersian, matchesPersianQuery } from './input-normalization'

/**
 * What a keyboard produces, against what a customer meant.
 *
 * These are not edge cases. Persian and Arabic share letters that carry
 * separate Unicode codepoints, and which one arrives depends on the keyboard
 * rather than on the person: the stock Arabic keyboard on iOS emits the Arabic
 * yeh and kaf, so a customer typing «بربري» into a shop that stocks «بربری»
 * is told there is no such bread. The search box in the launch artwork is the
 * one in the header of every page, and this is what makes it answer.
 */

describe('folding Persian text for search', () => {
  /**
   * The failure this exists to prevent, and the one most Iranian apps ship
   * with: the stock Arabic keyboard on iOS emits U+064A for yeh and U+0643 for
   * kaf, so a customer typing their own language is told the shop has no such
   * bread.
   */
  it('treats the Arabic and Persian forms of a letter as one letter', () => {
    expect(matchesPersianQuery('نان بربری', 'بربري')).toBe(true)
    expect(matchesPersianQuery('نان سنگک', 'سنگك')).toBe(true)
    expect(foldPersian('بربري')).toBe(foldPersian('بربری'))
    expect(foldPersian('سنگك')).toBe(foldPersian('سنگک'))
  })

  it('ignores the hamza somebody did or did not type', () => {
    expect(foldPersian('آرد')).toBe(foldPersian('ارد'))
    expect(matchesPersianQuery('نان تافتون', 'تأفتون')).toBe(true)
  })

  it('ignores harakat, which are pasted in and never typed', () => {
    expect(foldPersian('نَان')).toBe('نان')
    expect(matchesPersianQuery('کماج', 'کَماج')).toBe(true)
  })

  /**
   * Persian compounds are written with a half-space. A phone keyboard usually
   * produces an ordinary space, and plenty of people produce nothing at all.
   * All three are the same word.
   */
  it('reads a half-space, a space and no space as the same word', () => {
    expect(matchesPersianQuery('نان‌های محلی', 'نان های')).toBe(true)
    expect(matchesPersianQuery('نان سنگک', 'نان‌سنگک')).toBe(true)
    expect(matchesPersianQuery('نان‌سنگک', 'نان سنگک')).toBe(true)
  })

  it('accepts Persian digits in a name', () => {
    expect(matchesPersianQuery('نان ۲ کیلویی', '2 کیلویی')).toBe(true)
    expect(matchesPersianQuery('نان 2 کیلویی', '۲')).toBe(true)
  })

  /**
   * Somebody searching for bread lists attributes rather than quoting a name,
   * so the words may arrive in any order. Requiring the phrase in order fails
   * the more natural of the two.
   */
  it('matches every word in any order', () => {
    expect(matchesPersianQuery('نان سنگک تازه', 'تازه سنگک')).toBe(true)
    expect(matchesPersianQuery('نان سنگک تازه', 'سنگک کنجدی')).toBe(false)
  })

  it('matches everything when nothing has been typed', () => {
    expect(matchesPersianQuery('نان بربری', '')).toBe(true)
    expect(matchesPersianQuery('نان بربری', '   ')).toBe(true)
  })

  it('does not match a word that is simply not there', () => {
    expect(matchesPersianQuery('نان بربری', 'شیرینی')).toBe(false)
  })
})
