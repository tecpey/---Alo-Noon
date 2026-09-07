import { afterEach, describe, expect, it } from 'vitest'

import robots from './robots'
import sitemap from './sitemap'

/**
 * What a crawler is told, which is worth a test for one asymmetric reason: a
 * mistake in the permissive direction costs a little crawl budget on pages that
 * are `noindex` anyway, and a mistake in the restrictive direction takes the
 * shop out of every search result and nobody notices for a month.
 */
const original = process.env['WEB_BASE_URL']

afterEach(() => {
  if (original === undefined) delete process.env['WEB_BASE_URL']
  else process.env['WEB_BASE_URL'] = original
})

describe('what a crawler is told', () => {
  it('never disallows the shop or the pages that say who runs it', () => {
    const rules = robots().rules
    const disallowed = Array.isArray(rules) ? [] : [rules.disallow ?? []].flat()

    // The trust pages are the whole reason a sitemap exists here: an eNamad
    // reviewer and a wary customer both go looking for them.
    for (const path of ['/', '/legal/terms', '/legal/refunds', '/legal/privacy']) {
      expect(disallowed).not.toContain(path)
    }
    expect(disallowed).toContain('/admin')
    expect(disallowed).toContain('/bakery')
    expect(disallowed).toContain('/wallet')
  })

  it('lists every legal page in the sitemap, and no product', () => {
    process.env['WEB_BASE_URL'] = 'https://example.test'
    const paths = sitemap().map((entry) => new URL(entry.url).pathname)

    expect(paths).toEqual([
      '/',
      '/legal/terms',
      '/legal/refunds',
      '/legal/privacy',
      '/legal/contact',
    ])
    // A product sitemap would advertise this morning's price to a search engine
    // long after the shop stopped honouring it.
    expect(paths.some((path) => path.startsWith('/products'))).toBe(false)
  })

  it('names the sitemap absolutely, from the configured origin', () => {
    process.env['WEB_BASE_URL'] = 'https://alonoon.test'
    expect(robots().sitemap).toBe('https://alonoon.test/sitemap.xml')
  })

  it('falls back to localhost rather than emitting a malformed origin', () => {
    // A crash here would take the storefront down over a metadata concern, and
    // an interpolated bad value would end up in a file search engines read.
    for (const value of ['', '   ', 'not a url', 'ftp://example.test', 'https://a:b@x.test']) {
      process.env['WEB_BASE_URL'] = value
      expect(robots().sitemap).toBe('http://localhost:3000/sitemap.xml')
    }
  })

  it('keeps only the origin when the variable carries a path', () => {
    process.env['WEB_BASE_URL'] = 'https://alonoon.test/shop/'
    expect(robots().sitemap).toBe('https://alonoon.test/sitemap.xml')
  })
})
