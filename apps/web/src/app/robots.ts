import type { MetadataRoute } from 'next'

import { siteUrl } from '../lib/site-url'

export const dynamic = 'force-dynamic'

/**
 * What a crawler should and should not spend its time on.
 *
 * Every path disallowed here is already `noindex` on the page itself, so this
 * is not what keeps a panel out of a search result — the page's own metadata
 * is. What this saves is the crawl: a bot working through an operator panel it
 * will be refused by, order by order, is a bot not reading the shop.
 *
 * The four legal pages are deliberately *not* disallowed. They are the ones an
 * eNamad reviewer opens, the ones a customer searches for when they want to
 * know who they are buying from, and a trust page nobody can find is not a
 * trust page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/bakery', '/account', '/wallet', '/checkout', '/orders', '/payments'],
    },
    sitemap: new URL('/sitemap.xml', siteUrl()).toString(),
  }
}
