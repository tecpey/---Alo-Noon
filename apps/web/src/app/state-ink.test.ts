import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/*
  State text is written in its ink, not in the raw state colour.

  The raw colours — `--success`, `--warning`, `--error`, `--info`, and the admin
  panel's `--ok`, `--warn`, `--bad` aliases — are for borders, icons and fills.
  As text they fail WCAG 1.4.3: measured, raw amber is 2.57:1 on the page and
  2.74:1 on its own tint, which is where the admin panel set "degraded" on the
  payment-gateway health badge. The wallet's "credited" line and the checkout
  totals used raw green at 3.77:1.

  `--tint-<state>-ink` is emitted by the design tokens and its contrast is
  checked there against every surface. This file only makes sure the
  stylesheets use it.
*/

const STYLES_ROOT = join(import.meta.dirname, '..')

const files = readdirSync(STYLES_ROOT, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
  .map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return { path: path.slice(STYLES_ROOT.length + 1), source: readFileSync(path, 'utf8') }
  })

describe('state colours in text', () => {
  it('finds the stylesheets it is guarding', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('never sets text in a raw state colour', () => {
    // `color:` at the start of a declaration only — `border-color`,
    // `background-color` and `outline-color` are non-text and may use the raw
    // colour, which clears the 3:1 WCAG asks of those.
    const rawText = /(?:^|[;{\s])color:\s*var\(--(success|warning|error|info|ok|warn|bad)\)/g
    const offences = files.flatMap(({ path, source }) =>
      [...source.matchAll(rawText)].map((match) => `${path}: color: var(--${match[1]})`),
    )
    expect(offences).toEqual([])
  })

  it('uses the ink the tokens emit, so the guard above has a right answer', () => {
    const inks = files.filter(({ source }) =>
      /color:\s*var\(--tint-(success|error)-ink\)/.test(source),
    )
    expect(inks.length).toBeGreaterThan(0)
  })
})
