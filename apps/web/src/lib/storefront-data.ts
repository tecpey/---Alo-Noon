import 'server-only'

import { cookies } from 'next/headers'

import type { ActiveCitySummary, DeliveryEstimate, ProductDetail } from '@alo-noon/contracts'

import { linesFromCart } from './basket-lines'
import { buildCatalogView, type CatalogView } from './catalog-view'
import { SESSION_COOKIE } from './api-core'
import {
  deliveryEstimate,
  listCities,
  listOrders,
  listProducts,
  readCart,
  readProduct,
} from './shop-api'
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

/**
 * The signed-in customer's basket as the page needs it: the lines to render and
 * the version any write must quote back. Null all the way down when nobody is
 * signed in, which is the ordinary case rather than a fault.
 */
export interface ServerBasket {
  readonly signedIn: boolean
  readonly lines: readonly (readonly [string, number])[]
  readonly version?: number
}

export async function loadServerBasket(): Promise<ServerBasket> {
  const result = await readCart()
  if (!result.ok) return { signedIn: false, lines: [] }
  const cart = result.data
  return {
    signedIn: true,
    lines: [...linesFromCart(cart)],
    ...(cart && { version: cart.version }),
  }
}

/**
 * The one order the home page offers to repeat, or nothing.
 *
 * Reduced to the four things the card shows rather than handed the whole
 * `OrderSummary`: the card is a client component, so everything passed to it
 * crosses into the browser bundle, and an order carries payment states and a
 * rating that have no business on the shop's front page.
 */
export interface RepeatableOrder {
  readonly orderId: string
  readonly items: readonly { readonly nameFa: string; readonly quantity: number }[]
  readonly total: string
  readonly placedAt: string
}

/**
 * The most recent order, for the returning customer.
 *
 * Null for everybody else, and null rather than an error when the call fails:
 * this is an offer on top of a page that works without it, so a slow or
 * unhappy orders endpoint must cost the shop its shortcut and nothing else.
 */
export async function loadLastOrder(): Promise<RepeatableOrder | null> {
  // The cookie first, so an anonymous visit to the shop's front page does not
  // spend a round trip on an endpoint that can only answer 401. Most visits are
  // anonymous, and this page is `force-dynamic` — the call would be made every
  // time, for everybody, to learn something the request already says.
  const cookieStore = await cookies()
  if (!cookieStore.get(SESSION_COOKIE)) return null

  const result = await listOrders()
  if (!result.ok || result.data.length === 0) return null
  // The API returns newest first, which the orders page also relies on.
  const [order] = result.data
  if (!order || order.items.length === 0) return null
  return {
    orderId: order.id,
    items: order.items.map((item) => ({ nameFa: item.nameFaSnapshot, quantity: item.quantity })),
    total: order.total.amount,
    placedAt: order.createdAt,
  }
}

export type StorefrontData =
  | {
      readonly state: 'ready'
      readonly city: ActiveCitySummary
      /**
       * Every city this shop is open in, not only the chosen one.
       *
       * Carried through so the header can offer a move. Without it the city was
       * askable exactly once — `CitySwitch` renders only in `choose-city`, so
       * after the first tap there was no control anywhere that could change it,
       * and the city decides which bakeries exist at all.
       */
      readonly cities: readonly ActiveCitySummary[]
      readonly catalog: CatalogView
      /**
       * What delivery costs, said on the shelf rather than after sign-in, an
       * address and a delivery window. Null when no tariff is published for
       * this scope, which renders as no fare line.
       */
      readonly fare: DeliveryEstimate | null
    }
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
  | {
      readonly state: 'ready'
      readonly city: ActiveCitySummary
      readonly cities: readonly ActiveCitySummary[]
      readonly zoneId?: string
    }
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
  return { state: 'ready', city, cities: cities.data, ...(zoneId && { zoneId }) }
}

export async function loadStorefront(): Promise<StorefrontData> {
  const choice = await resolveCity()
  if (choice.state !== 'ready') return choice

  // Together, because the fare does not depend on the shelf and the shelf must
  // not wait on the fare. A tariff lookup that is slow or unhappy costs a line
  // of text; it may never cost the bread.
  const [products, fare] = await Promise.all([
    listProducts(choice.city.id, choice.zoneId ? { operationalZoneId: choice.zoneId } : {}),
    deliveryEstimate({
      cityId: choice.city.id,
      ...(choice.zoneId && { operationalZoneId: choice.zoneId }),
    }),
  ])
  if (!products.ok) return { state: 'unavailable', message: products.error.message }

  return {
    state: 'ready',
    city: choice.city,
    cities: choice.cities,
    catalog: buildCatalogView(products.data, choice.city.id),
    fare: fare.ok ? fare.data.estimate : null,
  }
}

/**
 * The city checkout is happening in, or nothing.
 *
 * An address belongs to a city, and the API decides which zone and service area
 * a set of coordinates falls in against that city's own areas. Checkout cannot
 * invent one: saving an address under the wrong city would produce a delivery
 * fare measured against zones no courier there works.
 */
export async function resolveCheckoutCity(): Promise<ActiveCitySummary | null> {
  const choice = await resolveCity()
  return choice.state === 'ready' ? choice.city : null
}

/**
 * Which branch context each offering on sale right now belongs to.
 *
 * Writing to the cart means naming a city and a zone that match the offering's
 * own branch, and a basket carried in from a browser holds only offering ids.
 * Resolving them against the live catalog rather than against anything stored
 * alongside them means a bread that has since been withdrawn simply is not in
 * the map, and is left behind instead of being written into a cart it can no
 * longer belong to.
 */
export async function offeringContexts(): Promise<
  ReadonlyMap<string, { cityId: string; operationalZoneId: string }>
> {
  const choice = await resolveCity()
  if (choice.state !== 'ready') return new Map()

  const products = await listProducts(
    choice.city.id,
    choice.zoneId ? { operationalZoneId: choice.zoneId } : {},
  )
  if (!products.ok) return new Map()

  return new Map(
    products.data.map((product) => [
      product.offeringId,
      { cityId: choice.city.id, operationalZoneId: product.operationalZoneId },
    ]),
  )
}

export type ProductPageData =
  | {
      readonly state: 'ready'
      readonly city: ActiveCitySummary
      /** The other cities, so a bread's page offers the same move the shop does. */
      readonly cities: readonly ActiveCitySummary[]
      readonly product: ProductDetail
    }
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
  if (product.ok)
    return { state: 'ready', city: choice.city, cities: choice.cities, product: product.data }

  // A bread that is not sold here is a missing page, not a broken one. Every
  // other failure keeps its own message, so "we could not reach the catalog"
  // is never dressed up as "this bread does not exist".
  if (product.error.code === 'PRODUCT_NOT_FOUND') return { state: 'missing' }
  return { state: 'unavailable', message: product.error.message }
}
