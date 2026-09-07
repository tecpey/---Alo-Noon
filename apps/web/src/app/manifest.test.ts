import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import manifest from './manifest'

/**
 * What has to be true before a phone will install the shop.
 *
 * Installability is decided by a browser reading this file, silently. There is
 * no error and no warning when it is wrong — the install option simply never
 * appears, and the way anybody finds out is that nobody installed the app.
 *
 * So the rules are checked here: the fields Chrome requires, an icon large
 * enough to satisfy it, a maskable icon that Android will not clip, and files
 * that are actually on disk at the sizes they claim.
 */
const PUBLIC = new URL('../../public', import.meta.url)

/** Width and height straight out of the PNG header, no decoder needed. */
function pngSize(path: string): { width: number; height: number; opaque: boolean } {
  const bytes = readFileSync(new URL(`.${path}`, `${PUBLIC.href}/`))
  // IHDR starts at byte 8; width and height are the two big-endian words after
  // the chunk header, and the colour type at byte 25 says whether alpha exists.
  const colourType = bytes[25]
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    // 4 is greyscale+alpha, 6 is truecolour+alpha. Anything else has no alpha
    // channel at all and is therefore fully opaque.
    opaque: colourType !== 4 && colourType !== 6,
  }
}

describe('the manifest a phone reads before offering to install', () => {
  const app = manifest()

  it('carries every field Chrome requires, or the option never appears', () => {
    expect(app.name).toBeTruthy()
    expect(app.short_name).toBeTruthy()
    expect(app.start_url).toBe('/')
    expect(app.display).toBe('standalone')
    // A shop that opened as a bare page inside the app frame would be an app
    // with a browser inside it.
    expect(app.scope).toBe('/')
    expect(app.background_color).toBeTruthy()
  })

  it('speaks Persian, right to left, before a single pixel is drawn', () => {
    // The splash screen is painted from this file, before any stylesheet has
    // loaded. A missing direction here is a left-aligned Persian name on the
    // first thing anybody sees of the installed shop.
    expect(app.lang).toBe('fa-IR')
    expect(app.dir).toBe('rtl')
    expect(app.name).toMatch(/[؀-ۿ]/)
  })

  it('keeps a name short enough to survive a home screen', () => {
    // Android truncates past roughly a dozen characters, and a truncated brand
    // is a brand somebody has to guess at.
    expect(app.short_name!.length).toBeLessThanOrEqual(12)
  })

  it('offers an icon big enough to be installable at all', () => {
    const any = (app.icons ?? []).filter((icon) => icon.purpose === 'any')
    expect(any.length).toBeGreaterThan(0)
    const largest = Math.max(...any.map((icon) => Number(icon.sizes?.split('x')[0] ?? 0)))
    // Chrome will not offer to install without one of at least 192.
    expect(largest).toBeGreaterThanOrEqual(192)
  })

  /**
   * The one that is silently wrong everywhere.
   *
   * Android does not use the "any" icon on a home screen; it masks a maskable
   * one into whatever shape the launcher uses. With no maskable icon declared
   * it takes the transparent one and drops it inside a grey circle, which is
   * how a carefully drawn mark ends up looking like a mistake.
   */
  it('declares a maskable icon, opaque and unclippable', () => {
    const maskable = (app.icons ?? []).filter((icon) => icon.purpose === 'maskable')
    expect(maskable.length).toBeGreaterThan(0)

    for (const icon of maskable) {
      const file = pngSize(icon.src)
      // Transparent corners plus a circular mask is a logo floating in grey.
      expect(file.opaque).toBe(true)
    }
  })

  it('points at files that exist, at the sizes it promises', () => {
    const sources = [
      ...(app.icons ?? []).map((icon) => ({ src: icon.src, sizes: icon.sizes })),
      ...(app.shortcuts ?? []).flatMap((shortcut) =>
        (shortcut.icons ?? []).map((icon) => ({ src: icon.src, sizes: icon.sizes })),
      ),
    ]
    expect(sources.length).toBeGreaterThan(0)

    for (const { src, sizes } of sources) {
      // A manifest that names a missing icon is a manifest a browser rejects
      // wholesale — no install offer, no message saying why.
      expect(() => statSync(new URL(`.${src}`, `${PUBLIC.href}/`))).not.toThrow()
      const file = pngSize(src)
      const [width, height] = (sizes ?? '').split('x').map(Number)
      expect(`${src}: ${file.width}x${file.height}`).toBe(`${src}: ${width}x${height}`)
    }
  })

  /**
   * The identity a phone keys the installed app on.
   *
   * If this ever changes, every phone that already installed the shop treats
   * the next version as a different application: the old one stays on the home
   * screen, orphaned, and the new one installs beside it.
   */
  it('keeps a fixed identity', () => {
    expect(app.id).toBe('/')
  })

  it('offers the two shortcuts worth long-pressing for, and no more', () => {
    const urls = (app.shortcuts ?? []).map((shortcut) => shortcut.url)
    expect(urls).toEqual(['/orders', '/wallet'])
    // A shortcut menu that lists everything is a menu nobody reads.
    expect(urls.length).toBeLessThanOrEqual(4)
  })

  it('agrees with the service worker about where the offline page is', () => {
    // The worker precaches `/offline`; the page exists to be precached. If one
    // is renamed without the other, being offline shows a browser error and
    // nothing fails until then.
    const worker = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
    expect(worker).toContain("OFFLINE_URL = '/offline'")

    // And every icon the worker precaches is one the manifest names, so a
    // rename cannot leave the worker holding a file nothing points at.
    const precached = [...worker.matchAll(/'(\/brand\/[^']+)'/g)].map((match) => match[1])
    const declared = new Set((app.icons ?? []).map((icon) => icon.src))
    for (const src of precached) expect(declared.has(src!)).toBe(true)
  })
})
