import 'server-only'

import { cookies } from 'next/headers'

import type { ActiveCitySummary } from '@alo-noon/contracts'

import { buildCatalogView, type CatalogView } from './catalog-view'
import { listCities, listProducts } from './shop-api'
import { CITY_COOKIE, ZONE_COOKIE } from './shop-cookies'

/**
 * Everything the storefront needs before it can render a single loaf.
 *
 * The catalog is city-scoped at the API — prices, availability and which
 * bakeries exist are all answers to "where" — so a city has to be settled
 * before there is anything to show. This resolves it once, per request, and
 * hands the page a single value it can render without asking any more
 * questions.
 */

export type StorefrontData =
  | { readonly state: 'ready'; readonly city: ActiveCitySummary; readonly catalog: CatalogView }
  /** Cities loaded, but this visitor has to pick one before there is a catalog. */
  | { readonly state: 'choose-city'; readonly cities: readonly ActiveCitySummary[] }
  /** The shop is not open anywhere — no active city has a live service area. */
  | { readonly state: 'closed' }
  /** The API could not be reached or refused; the page says so rather than looking empty. */
  | { readonly state: 'unavailable'; readonly message: string }

export async function loadStorefront(): Promise<StorefrontData> {
  const cities = await listCities()
  if (!cities.ok) return { state: 'unavailable', message: cities.error.message }
  if (cities.data.length === 0) return { state: 'closed' }

  const cookieStore = await cookies()
  const chosen = cookieStore.get(CITY_COOKIE)?.value
  const city =
    cities.data.find((entry) => entry.id === chosen) ??
    // One city is not a choice. Asking anyway would be a screen whose only
    // possible answer is the one the shop already knows.
    (cities.data.length === 1 ? cities.data[0] : undefined)
  if (!city) return { state: 'choose-city', cities: cities.data }

  const zone = cookieStore.get(ZONE_COOKIE)?.value
  const products = await listProducts(city.id, zone ? { operationalZoneId: zone } : {})
  if (!products.ok) return { state: 'unavailable', message: products.error.message }

  return { state: 'ready', city, catalog: buildCatalogView(products.data) }
}
