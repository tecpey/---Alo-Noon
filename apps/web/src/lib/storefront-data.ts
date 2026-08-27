import 'server-only'

import { cookies } from 'next/headers'

import type { ActiveCitySummary } from '@alo-noon/contracts'

import type { ProductDetail } from '@alo-noon/contracts'

import { buildCatalogView, type CatalogView } from './catalog-view'
import { listCities, listProducts, readProduct } from './shop-api'
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

/**
 * Which city this visitor is shopping in, and which zone within it.
 *
 * Shared by the storefront and the product page so a bread's own page is
 * priced against the same city the card that linked to it was.
 */
type CityChoice =
  | { readonly state: 'ready'; readonly city: ActiveCitySummary; readonly zoneId?: string }
  | { readonly state: 'choose-city'; readonly cities: readonly ActiveCitySummary[] }
  | { readonly state: 'closed' }
  | { readonly state: 'unavailable'; readonly message: string }

async function resolveCity(): Promise<CityChoice> {
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

  const zoneId = cookieStore.get(ZONE_COOKIE)?.value
  return { state: 'ready', city, ...(zoneId && { zoneId }) }
}

export async function loadStorefront(): Promise<StorefrontData> {
  const choice = await resolveCity()
  if (choice.state !== 'ready') return choice

  const products = await listProducts(
    choice.city.id,
    choice.zoneId ? { operationalZoneId: choice.zoneId } : {},
  )
  if (!products.ok) return { state: 'unavailable', message: products.error.message }

  return { state: 'ready', city: choice.city, catalog: buildCatalogView(products.data) }
}

export type ProductPageData =
  | { readonly state: 'ready'; readonly city: ActiveCitySummary; readonly product: ProductDetail }
  /** The slug is not on sale in this city. The page answers 404. */
  | { readonly state: 'missing' }
  | { readonly state: 'choose-city'; readonly cities: readonly ActiveCitySummary[] }
  | { readonly state: 'closed' }
  | { readonly state: 'unavailable'; readonly message: string }

export async function loadProduct(slug: string): Promise<ProductPageData> {
  const choice = await resolveCity()
  if (choice.state !== 'ready') return choice

  const product = await readProduct(
    slug,
    choice.city.id,
    choice.zoneId ? { operationalZoneId: choice.zoneId } : {},
  )
  if (product.ok) return { state: 'ready', city: choice.city, product: product.data }

  // A bread that is not sold here is a missing page, not a broken one. Every
  // other failure keeps its own message, so "we could not reach the catalog"
  // is never dressed up as "this bread does not exist".
  if (product.error.code === 'PRODUCT_NOT_FOUND') return { state: 'missing' }
  return { state: 'unavailable', message: product.error.message }
}
