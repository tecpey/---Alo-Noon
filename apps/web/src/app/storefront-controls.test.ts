import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { matchesPersianQuery } from '@alo-noon/domain'

/**
 * Controls that look like they work, checked for whether they do.
 *
 * This repository has shipped the same defect three times: three delivery
 * conditions rendered as buttons with no handler, category chips with
 * `role="tab"` that changed nothing, and a search box with a placeholder and no
 * `onChange`. Each looked finished in a screenshot. Each taught a customer that
 * a control on this page might be decoration — and the search box was the worst
 * of the three, because somebody who types a bread's name and sees the page not
 * move concludes the shop does not stock it.
 *
 * Asserting on source text is blunt and it is deliberate, in the same spirit as
 * `mobile-first.test.ts` next door: what these guard is not behaviour that a
 * unit test could exercise, it is the presence of the wiring that makes the
 * behaviour reachable at all. A component test with a DOM would be better and
 * costs a testing-library setup this app does not have; this costs nothing and
 * catches the exact regression that has already happened twice.
 */
const APP_ROOT = join(import.meta.dirname)
const read = (path: string) => readFileSync(join(APP_ROOT, path), 'utf8')

describe('the search box in the header', () => {
  const header = read('components/site-header.tsx')

  it('is controlled, rather than a placeholder over nothing', () => {
    expect(header).toMatch(/value=\{query\}/)
    expect(header).toMatch(/onChange=\{\(event\) => setQuery\(event\.target\.value\)\}/)
  })

  it('offers a way out of a search, which is the state people get stuck in', () => {
    expect(header).toMatch(/setQuery\(''\)/)
  })
})

describe('the shelves', () => {
  const shelf = read('components/shelf.tsx')

  it('filter by what was typed and not only by the chip', () => {
    expect(shelf).toContain('matchesPersianQuery')
    expect(shelf).toMatch(/query/)
  })

  /**
   * The two filters empty a shelf for different reasons and the way out
   * differs. Telling somebody who searched «کماج» that the category is empty
   * sends them to press a chip that cannot help.
   */
  it('say which filter emptied them', () => {
    expect(shelf).toContain('پیدا نشد')
    expect(shelf).toContain('نمایش همهٔ نان‌ها')
  })
})

describe('what the search actually answers', () => {
  // The catalogue's own wording, against what a phone keyboard produces.
  const shelfNames = ['نان بربری', 'نان سنگک کنجدی', 'نان لواش', 'کماج', 'نان تافتون']
  const find = (query: string) => shelfNames.filter((name) => matchesPersianQuery(name, query))

  it('finds a bread typed on an Arabic keyboard', () => {
    // The stock iOS Arabic keyboard emits U+064A for yeh and U+0643 for kaf.
    expect(find('بربري')).toEqual(['نان بربری'])
    expect(find('سنگك')).toEqual(['نان سنگک کنجدی'])
  })

  it('finds a bread by a word from the middle of its name', () => {
    expect(find('کنجدی')).toEqual(['نان سنگک کنجدی'])
  })

  it('shows everything when the box is empty', () => {
    expect(find('')).toHaveLength(shelfNames.length)
  })
})

describe('the category tiles', () => {
  const rail = read('components/category-rail.tsx')

  it('still filter, which is what they are for', () => {
    // They were `role="tab"` and changed nothing once. A prettier control that
    // does nothing is a worse control.
    expect(rail).toContain('selectCategory(entry.code)')
    expect(rail).toContain('aria-pressed={active}')
  })

  it('give each launch category its own bread', () => {
    // The codes the bootstrap creates. A category row of identical circles is a
    // row of identical circles.
    for (const [code, glyph] of [
      ['SPECIAL', 'OvenIcon'],
      ['SANGAK', 'SangakIcon'],
      ['BARBARI', 'BarbariIcon'],
      ['LAVASH', 'LavashIcon'],
      ['TAFTOON', 'TaftoonIcon'],
      ['SWEET', 'KomajIcon'],
    ]) {
      expect(rail).toMatch(new RegExp(`${code}:\\s*${glyph}`))
    }
  })

  /**
   * The shop can add a category without a deploy — that is why the categories
   * are rows rather than a list in the source. Without a fallback the first one
   * added next spring renders as an empty circle, or as whichever bread happens
   * to be first in the map: a picture of the wrong loaf under the right name.
   */
  it('fall back rather than showing the wrong loaf for a code they do not know', () => {
    expect(rail).toContain('?? WheatIcon')
  })
})

describe('the city in the header', () => {
  const header = read('components/site-header.tsx')

  /**
   * It showed a hard-coded «شهرتان را انتخاب کنید» from the static content file
   * to somebody already shopping in Babol — a render at phone size had the real
   * city and the prompt on screen at the same time. The most persistent element
   * on the page, saying something untrue.
   */
  it('names the city the catalogue was actually priced in', () => {
    expect(header).toContain('cityNameFa')
    expect(header).toMatch(/cityNameFa \?\? address\?\.valueFa/)
  })

  /**
   * The pin was a `<button>` with no handler, and `CitySwitch` renders only in
   * the `choose-city` state — so after the first tap there was no control
   * anywhere that could change city again. The city decides which bakeries
   * exist and what the prices are, so somebody who tapped the wrong one had a
   * shop that would never show them bread they could buy.
   */
  it('opens the chooser, rather than being a button that does nothing', () => {
    expect(header).toContain('onClick={openCity}')
  })

  /** A control that opens a list of one is a control that should not be there. */
  it('is plain text when there is only one city', () => {
    expect(header).toMatch(/cities\.length > 1/)
  })

  it('offers every city the shop is open in, and marks the current one', () => {
    const sheet = read('components/city-sheet.tsx')
    expect(sheet).toContain('selectCityAction')
    expect(sheet).toContain('aria-current')
  })
})

describe('the hero', () => {
  /**
   * Measured at 390×844 the hero was 817px — ninety-seven per cent of the
   * screen — so a returning customer scrolled a full screen past a pitch they
   * had already read before seeing one loaf. Part of that was the delivery
   * address, printed here as well as in the pinned bar above it.
   */
  it('does not repeat the address the header already shows', () => {
    expect(read('page.tsx')).toMatch(/filter\(\(condition\) => condition\.id !== 'address'\)/)
  })
})

describe('the bottom tab bar', () => {
  const tabs = read('components/app-tabs.tsx')

  it('reaches the four places a customer goes', () => {
    for (const label of ['خانه', 'سفارش‌ها', 'پروفایل', 'سبد خرید']) {
      expect(tabs).toContain(label)
    }
  })

  /**
   * A bar pinned over the home indicator on a modern iPhone is a bar whose
   * labels cannot be read and whose tabs are hard to hit — and it is the one
   * control a customer uses on every visit.
   */
  it('keeps clear of the home indicator', () => {
    expect(read('storefront.css')).toMatch(/\.app-tabs\b[\s\S]*?env\(safe-area-inset-bottom/)
  })

  /** Panels are tools somebody is given, not a shop they browse. */
  it('stays out of the panels and the checkout', () => {
    for (const prefix of ['/admin', '/bakery', '/checkout', '/payments']) {
      expect(tabs).toContain(`'${prefix}'`)
    }
  })
})
