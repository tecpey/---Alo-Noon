import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FONT_FAMILY_NAMES, FONT_FILE_DIGESTS } from '@alo-noon/mobile-ui/typography'

/**
 * The typeface this app ships, checked as files on disk.
 *
 * Nothing here is exercised by running the app in development, where a missing
 * font is a shrug: Metro serves what it finds, and on a laptop the fallback is
 * a Latin face that makes Persian look obviously wrong, so it gets fixed. On a
 * phone the fallback is Geeza Pro on iOS and Noto Naskh on Android — both
 * legible, neither the brand — so the app looks *fine*, just not like itself,
 * and a rider in a hurry is the last person who is going to report it.
 *
 * At the app root rather than under `src/`, matching `release-config.test.ts`:
 * both read files that the bundler consumes rather than code the app imports.
 */
const FONTS = join(import.meta.dirname, 'assets', 'fonts')

describe('the font files', () => {
  it.each(FONT_FAMILY_NAMES)('ships %s under exactly the name that is loaded', (name) => {
    // `src/fonts.ts` requires these paths by name. A rename here is a family
    // that never registers, and text that silently falls back.
    expect(statSync(join(FONTS, `${name}.ttf`)).isFile()).toBe(true)
  })

  /**
   * TrueType, not WOFF2. The web app's copy of Vazirmatn is a woff2 and cannot
   * be reused here: React Native has no Brotli decompressor, and a woff2 given
   * a `.ttf` name fails to load at runtime with nothing a screen could show.
   */
  it.each(FONT_FAMILY_NAMES)('has %s as real TrueType, not a renamed web font', (name) => {
    const head = readFileSync(join(FONTS, `${name}.ttf`)).subarray(0, 4)
    // 0x00010000 is the TrueType version tag; 'wOF2' is what a woff2 starts with.
    expect([...head]).toEqual([0x00, 0x01, 0x00, 0x00])
  })

  /**
   * The digest is declared in `@alo-noon/mobile-ui` and checked by both apps, so
   * the customer app and the courier app cannot end up on different cuts of the
   * same typeface — which is invisible unless the two phones are side by side,
   * and reads as two products from two companies when they are.
   */
  it.each(FONT_FAMILY_NAMES)('has %s at the exact bytes the shared package pins', (name) => {
    const digest = createHash('sha256')
      .update(readFileSync(join(FONTS, `${name}.ttf`)))
      .digest('hex')
    expect(digest).toBe(FONT_FILE_DIGESTS[name])
  })

  /** The licence travels with the font, as the SIL OFL requires. */
  it('ships the licence beside them', () => {
    const licence = readFileSync(join(FONTS, 'OFL.txt'), 'utf8')
    expect(licence).toContain('SIL Open Font License')
    expect(licence).toContain('Vazirmatn')
  })
})
