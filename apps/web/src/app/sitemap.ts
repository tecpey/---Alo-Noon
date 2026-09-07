import type { MetadataRoute } from 'next'

import { siteUrl } from '../lib/site-url'

export const dynamic = 'force-dynamic'

/**
 * The pages worth indexing, which is a short list on purpose.
 *
 * Products are absent. The catalogue is scoped to a customer's city and changes
 * through the day — what a bakery offers this morning is not what it offers
 * tonight — so a sitemap of product URLs would be stale before it was fetched
 * and would advertise prices to a search engine that the shop no longer honours.
 * The storefront links every product it is actually selling; a crawler that
 * follows those sees today's shop rather than a snapshot of some other day's.
 *
 * The legal pages are the reason this file exists. They are what an eNamad
 * reviewer, a payment gateway's compliance team and a wary customer go looking
 * for, and none of them should have to guess a URL.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteUrl()
  const url = (path: string) => new URL(path, origin).toString()

  return [
    { url: url('/'), changeFrequency: 'daily', priority: 1 },
    { url: url('/legal/terms'), changeFrequency: 'yearly', priority: 0.5 },
    { url: url('/legal/refunds'), changeFrequency: 'yearly', priority: 0.5 },
    { url: url('/legal/privacy'), changeFrequency: 'yearly', priority: 0.5 },
    { url: url('/legal/contact'), changeFrequency: 'monthly', priority: 0.5 },
  ]
}
