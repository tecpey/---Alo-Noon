import { describe, expect, it } from 'vitest'

import { FONT_FAMILY_NAMES, FONT_FILE_DIGESTS, fontFamily, persianText } from './typography'

/**
 * The naming scheme, which is the part of the font story that lives here.
 *
 * The files themselves belong to the two apps and are checked by their own
 * tests — this package must not read out of `apps/`, and a shared package that
 * asserts things about its consumers is a dependency pointing the wrong way.
 *
 * What it does own is the contract both apps compile against, and the failure
 * that contract prevents is silent: a family name that does not match a loaded
 * file renders in the system font, and the system font for Persian on iOS is
 * Geeza Pro. Nothing throws, nothing logs.
 */

describe('the family names', () => {
  it('are distinct, since one name per weight is the whole scheme', () => {
    expect(new Set(FONT_FAMILY_NAMES).size).toBe(FONT_FAMILY_NAMES.length)
  })

  it('name every weight a screen can ask for', () => {
    expect([...FONT_FAMILY_NAMES].sort()).toEqual([...Object.values(fontFamily)].sort())
  })

  /**
   * The mistake this package exists to prevent. `fontWeight` beside a custom
   * `fontFamily` is ignored on iOS, so a heading asking for 800 renders at 400
   * and looks merely flat rather than broken.
   */
  it('never come with a fontWeight attached', () => {
    for (const weight of ['regular', 'bold', 'extraBold'] as const) {
      expect(persianText(weight)).toEqual({ fontFamily: fontFamily[weight] })
    }
  })

  it('default to regular, which is what body text is', () => {
    expect(persianText()).toEqual({ fontFamily: fontFamily.regular })
  })
})

describe('the file digests', () => {
  it('cover every family, so no app can ship an unpinned cut', () => {
    expect(Object.keys(FONT_FILE_DIGESTS).sort()).toEqual([...FONT_FAMILY_NAMES].sort())
  })

  it('are distinct SHA-256 hex, since three identical weights would be one weight', () => {
    const digests = Object.values(FONT_FILE_DIGESTS)
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(digests).size).toBe(digests.length)
  })
})
