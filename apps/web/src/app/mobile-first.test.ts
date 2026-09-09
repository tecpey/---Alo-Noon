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

describe('the phone the shop is held in', () => {
  it('keeps its fixed edges clear of the notch and the home indicator', () => {
    // Anything pinned to an edge — the top bar, the basket's checkout button,
    // the footer — sits under the sensor housing or the gesture bar without
    // this, and a button under the gesture bar cannot be pressed at all.
    const insetUsers = files.filter(({ source }) => source.includes('env(safe-area-inset'))
    expect(insetUsers.map((file) => file.path).sort()).toContain('app/storefront.css')
    expect(insetUsers.length).toBeGreaterThan(2)
  })

  it('stops a sideways drag on a scroller from being read as the back gesture', () => {
    // A table dragged past its last column, or a chip rail flicked past its last
    // chip, hands the gesture to the browser — which navigates away from the
    // page the operator was reading.
    const contained = files.filter(({ source }) => source.includes('overscroll-behavior'))
    expect(contained.length).toBeGreaterThan(1)
  })
})
