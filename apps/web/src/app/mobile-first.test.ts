import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { breakpoints, touch } from '@alo-noon/design-tokens'
import { describe, expect, it } from 'vitest'

/**
 * The stylesheets are mobile-first, and this is what keeps them that way.
 *
 * Not a style preference. Every one of these files used to be written the other
 * way round — a desktop layout, then a list of `max-width` rules undoing it —
 * and the cost of that was not theoretical. The storefront's search box was laid
 * out 190 pixels off the left edge of every phone screen, hidden by the app
 * frame's `overflow: clip`, correct on every desktop anyone tested on, and
 * missing for every customer who ever opened the shop on a phone. A rule that is
 * only reached by shrinking the window is a rule nobody reads while writing the
 * one above it.
 *
 * So: the base is the phone, the media queries only widen, and the widths they
 * widen at are the two the design tokens name. All three are checkable by
 * reading the files, which is why they are checked by reading the files.
 */
const STYLES_ROOT = join(import.meta.dirname, '..')

function stylesheets(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.css'))
      found.push(join(entry.parentPath, entry.name))
  }
  return found
}

const files = stylesheets(STYLES_ROOT).map((path) => ({
  path: path.slice(STYLES_ROOT.length + 1),
  source: readFileSync(path, 'utf8'),
}))

/** Every `@media` condition in the codebase, tagged with the file it came from. */
const conditions = files.flatMap(({ path, source }) =>
  [...source.matchAll(/@media\s+([^{]+)\{/g)].map((match) => ({
    path,
    condition: match[1]!.trim(),
  })),
)

describe('the stylesheets are mobile-first', () => {
  it('has stylesheets to check at all', () => {
    // Guards the guard: a rename that empties the glob would turn every
    // assertion below into a test that passes by iterating nothing.
    expect(files.length).toBeGreaterThan(5)
    expect(conditions.length).toBeGreaterThan(5)
  })

  it('never lays out for a wide screen and undoes it for a narrow one', () => {
    const backwards = conditions.filter((entry) => entry.condition.includes('max-width'))
    // Named rather than counted: a failure here should say which file went back
    // to desktop-first, not that some number changed.
    expect(backwards.map((entry) => `${entry.path}: @media ${entry.condition}`)).toEqual([])
  })

  it('changes layout only at the two widths the tokens name', () => {
    const widths = conditions
      .flatMap((entry) => [...entry.condition.matchAll(/min-width:\s*([^)]+)\)/g)])
      .map((match) => match[1]!.trim())
    const allowed = new Set<string>(Object.values(breakpoints))
    // 30rem is the cash desk's own hinge — a four-column row of collection
    // amounts that has nothing to do with the page around it. Allowed, named,
    // and deliberately the only exception.
    allowed.add('30rem')
    expect([...new Set(widths)].filter((width) => !allowed.has(width))).toEqual([])
  })

  it('uses feature queries, not width queries, for things that are not about width', () => {
    // `prefers-reduced-motion` and `hover` are about the person and the input
    // device. They are the only non-width conditions expected here, and finding
    // a new one is worth a look rather than a silent pass.
    const nonWidth = conditions
      .filter((entry) => !entry.condition.includes('width'))
      .map((entry) => entry.condition)
    for (const condition of new Set(nonWidth)) {
      expect(condition).toMatch(/prefers-reduced-motion|hover|pointer|prefers-color-scheme/)
    }
  })
})

describe('controls are big enough to hit', () => {
  it('sizes them from the shared token rather than from a number typed in', () => {
    // The floor is shared with the phone applications. A stylesheet that writes
    // `min-block-size: 44px` instead is one that will not move when the token
    // does, and this product is used one-handed on a pavement.
    const uses = files.filter(({ source }) => source.includes('var(--touch-min)'))
    expect(uses.length).toBeGreaterThan(2)
    expect(touch.min).toBe('2.75rem')
  })

  it('applies the floor in the shared layer, so a new form inherits it', () => {
    const shared = files.find((file) => file.path === 'app/styles.css')
    expect(shared).toBeDefined()
    // The type selectors, not a component class: the point is that a control
    // added tomorrow is already covered.
    expect(shared!.source).toMatch(/button,\s*\n\s*select,\s*\n\s*textarea,/)
    expect(shared!.source).toContain('min-block-size: var(--touch-min)')
  })

  it('keeps every field at 16px, because below it iOS zooms and stays zoomed', () => {
    const shared = files.find((file) => file.path === 'app/styles.css')!
    expect(shared.source).toContain('font-size: max(1rem, 1em)')
  })

  it('never sets a field’s type with the `font` shorthand', () => {
    // How this broke the first time. `font: inherit` reads as "match the page",
    // but the shorthand also sets the *size*, and these fields sit inside rows
    // and tables at 0.9rem — so every filter in the admin panel came out at
    // 14.4px and made iOS zoom on focus. `font-family: inherit` says what was
    // meant. Checked on fields only: a button at the inherited size is fine,
    // because a button is not what the browser zooms for.
    const offenders: string[] = []
    for (const { path, source } of files) {
      for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selector = rule[1]!.trim().split('\n').pop()!.trim()
        if (!/\b(input|textarea|select)\b/.test(selector)) continue
        if (/^\s*font:/m.test(rule[2]!)) offenders.push(`${path}: ${selector}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * The customer stylesheets, which are the ones an eighty-year-old reads.
 *
 * The operator surfaces are excluded on purpose and by name: a 13px column
 * header in a shift-long admin table is a convention, and the person reading it
 * is at a desk doing this job all day. The shop is the opposite — held at arm's
 * length, one-handed, often by somebody who is not going to pinch-zoom.
 */
const CUSTOMER_STYLESHEETS = files.filter(
  ({ path }) => !path.includes('admin/') && !path.includes('bakery/'),
)

/** Every `selector { … }` rule in a file, flattened to the last selector line. */
function* rules(source: string) {
  for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    yield {
      selector: match[1]!.trim().split('\n').pop()!.trim(),
      body: match[2]!,
    }
  }
}

describe('nothing on a customer screen is too small to read', () => {
  /*
    13.6px, and the reasoning for the number rather than a rounder one.

    NIA and MedlinePlus put the floor for an older reader at 16px, and that is
    right for body copy — which is why every paragraph, price and field on these
    pages is at least 1rem. It is not a sane floor for a caption under a
    wordmark or the label under a tab glyph; applied literally it would give
    four tab labels the width of six. So body copy answers to NIA and the
    secondary layer answers to this: 0.85rem, the size the stylesheets already
    used for most of their small print, made the floor rather than the average.

    What it replaced was not a scale. It was 0.62rem on the basket count, 0.7rem
    on the tab labels — the shop's primary navigation, at 11.2px — 0.72rem on
    the order-tracking rail, and 0.78rem on the fare note beside the money. Each
    was individually defensible and together they were a product that cannot be
    read by the people it was built for.
  */
  const FLOOR_REM = 0.85

  /*
    Two numeric count badges, named so the exemption is a decision. Each is a
    digit or two inside a circle sized by the glyph it hangs off; the digits
    cannot grow without the circle growing, and the circle cannot grow without
    covering the icon it belongs to. They carry no information that is not also
    in the accessible name of their control.
  */
  const COUNT_BADGES = new Set(['.site-header__count', '.app-tabs__count'])
  const BADGE_FLOOR_REM = 0.75

  it('has customer stylesheets to check', () => {
    expect(CUSTOMER_STYLESHEETS.length).toBeGreaterThan(5)
  })

  it('sets no type below the floor', () => {
    const offenders: string[] = []
    for (const { path, source } of CUSTOMER_STYLESHEETS) {
      for (const { selector, body } of rules(source)) {
        for (const declared of body.matchAll(/font-size:\s*([0-9.]+)rem/g)) {
          const rem = Number.parseFloat(declared[1]!)
          const floor = COUNT_BADGES.has(selector) ? BADGE_FLOOR_REM : FLOOR_REM
          if (rem < floor) offenders.push(`${path}: ${selector} → ${rem}rem (${rem * 16}px)`)
        }
      }
    }
    // Named rather than counted, so a failure says which line and how small.
    expect(offenders).toEqual([])
  })

  it('takes white from the token rather than typing #fff', () => {
    // `ink.onAction` is #FFF9F2 — warm, because pure white punches a hole in
    // paper and the palette test forbids it. Three badges had `color: #fff`
    // hardcoded and so were exempt from that test by not going through it.
    const offenders: string[] = []
    for (const { path, source } of CUSTOMER_STYLESHEETS) {
      for (const match of source.matchAll(
        /(?:^|\n)\s*(?:color|background(?:-color)?):\s*(#[0-9a-fA-F]{3,8})/g,
      ))
        if (/^#(fff|ffffff|000|000000)$/i.test(match[1]!)) offenders.push(`${path}: ${match[1]}`)
    }
    expect(offenders).toEqual([])
  })
})

describe('the phone the shop is held in', () => {
  it('leaves a page its own side gutter', () => {
    /*
      A regression test for a one-character bug with a five-page blast radius.

      `.app-frame > main` sets the notch inset in physical longhands and scores
      (0,1,1). Every page that pads its own main does it from a single class at
      (0,1,0), with the `padding` shorthand — so the longhands won and the side
      gutters of the sign-in screen, the orders list, the wallet, the legal
      pages, the product page and the payment result all computed to zero. Text
      against the bare edge of the glass, in portrait, on every phone, from the
      day the notch rule was written.

      `:where()` drops it to zero specificity, which makes it a floor instead of
      an override. The assertion is on the mechanism rather than on any one
      page, because the next page to pad its own main will not think to check.
    */
    const storefront = files.find((file) => file.path === 'app/storefront.css')!
    expect(storefront.source).toContain(':where(.app-frame > main)')
    expect(storefront.source).not.toMatch(/(?<!:where\()\.app-frame > main\s*\{/)
  })

  it('keeps its fixed edges clear of the notch and the home indicator', () => {
    // Anything pinned to an edge — the top bar, the basket's checkout button,
    // the footer — sits under the sensor housing or the gesture bar without
    // this, and a button under the gesture bar cannot be pressed at all.
    const insetUsers = files.filter(({ source }) => source.includes('env(safe-area-inset'))
    expect(insetUsers.map((file) => file.path).sort()).toContain('app/storefront.css')
    expect(insetUsers.length).toBeGreaterThan(2)
  })

  it('asks the browser for the insets, without which the rule above is decorative', () => {
    // The test above passed for as long as the insets existed, and they did
    // nothing. Safari's default viewport is `viewport-fit=auto`: it fits the
    // page inside the safe area itself and reports all four `env()` values as
    // `0px`. So every rule written for a notched iPhone — each one commented
    // as such — computed to zero on a notched iPhone, and the only way to see
    // it was to hold one.
    //
    // Checking the stylesheet and the viewport separately is what let them
    // disagree, so they are checked together here.
    const layout = readFileSync(join(STYLES_ROOT, 'app/layout.tsx'), 'utf8')
    expect(layout).toMatch(/viewportFit:\s*'cover'/)
  })

  it('stops a sideways drag on a scroller from being read as the back gesture', () => {
    // A table dragged past its last column, or a chip rail flicked past its last
    // chip, hands the gesture to the browser — which navigates away from the
    // page the operator was reading.
    const contained = files.filter(({ source }) => source.includes('overscroll-behavior'))
    expect(contained.length).toBeGreaterThan(1)
  })
})
