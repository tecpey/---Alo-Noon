import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { touch } from '@alo-noon/design-tokens'
import { describe, expect, it } from 'vitest'

/**
 * Nothing anybody is expected to press is smaller than the shared floor.
 *
 * The same rule the web stylesheets carry, checked the same way — by reading
 * the source, because there is no browser here to measure a rendered tab bar
 * in. It is a coarser instrument than the web's and it is worth having anyway:
 * before it, the four tabs this whole application navigates by were about 37
 * points tall, the sign-out button was as tall as the word "خروج", and the
 * remove control in the basket was a 13-point line of text.
 *
 * What it can actually see is the shape of the mistake: a `Pressable` handed an
 * inline style whose only vertical size is a small `paddingVertical`. That is
 * how every one of those got there.
 *
 * At the app root rather than under `src/`, for the same reason
 * `release-config.test.ts` is: it reads files, and the application's tsconfig
 * describes a React Native bundle with no Node types in it.
 */
const APP_ROOT = import.meta.dirname

const SOURCES = [
  'App.tsx',
  'src/screens/tabs.tsx',
  'src/screens/account.tsx',
  'src/screens/orders.tsx',
  'src/screens/wallet.tsx',
  'src/screens/checkout-choices.tsx',
].map((path) => ({ path, source: readFileSync(join(APP_ROOT, path), 'utf8') }))

describe('every control is big enough to hit', () => {
  it('has the sources it means to check', () => {
    // Guards the guard: a renamed screen would otherwise make this a test that
    // passes by reading nothing.
    expect(SOURCES).toHaveLength(6)
    for (const { path, source } of SOURCES) {
      expect(`${path}: ${source.length > 500}`).toBe(`${path}: true`)
    }
  })

  it('never sizes a pressable with a bare vertical padding', () => {
    // `style={{ paddingVertical: 6 }}` on a Pressable is the exact shape of
    // every undersized target this app had. The floor is a named style, so a
    // control that needs one says so.
    const offenders: string[] = []
    for (const { path, source } of SOURCES) {
      for (const match of source.matchAll(/style=\{\{\s*paddingVertical:\s*(\d+)/g)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${path}:${line} paddingVertical: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('takes the floor from the shared token, not from a number typed in', () => {
    // A hard-coded 44 is one that will not move when the token does, and this
    // floor is shared with the web and the courier application.
    const using = SOURCES.filter(({ source }) => source.includes('touchTarget.'))
    expect(using.map(({ path }) => path)).toContain('src/screens/tabs.tsx')
    expect(using.length).toBeGreaterThan(3)
    expect(touch.minPoints).toBe(44)
  })

  it('reaches past a control that cannot grow, rather than leaving it small', () => {
    // The basket's remove control shares a fixed row with the item's name and
    // price. `hitSlop` is the answer there — it is the one mechanism that makes
    // a target bigger without making the layout bigger.
    const app = SOURCES.find(({ path }) => path === 'App.tsx')!
    expect(app.source).toContain('hitSlopTo(')
  })
})
