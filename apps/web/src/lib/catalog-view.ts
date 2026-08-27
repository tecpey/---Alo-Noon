import type { ProductSummary } from '@alo-noon/contracts'

/**
 * Turning the catalog API's answer into the shop a customer sees.
 *
 * All of it is pure, and none of it invents anything. The chips are the
 * categories the shop's own rows carry, the shelves are the fulfillment classes
 * the products are actually filed under, and both disappear when nothing in
 * them is for sale. A category chip that filters to an empty shelf is a chip
 * that should not have been drawn.
 */

export interface ShelfProduct {
  /**
   * What the cart is keyed on.
   *
   * Not the product id: the same bread at two branches is two offerings at two
   * prices, and a basket line has to mean one of them.
   */
  readonly offeringId: string
  /** The public address of the bread, for the product page. */
  readonly slug: string
  readonly nameFa: string
  readonly categoryCode: string
  /** Rial, as a decimal string, exactly as the ledger holds it. */
  readonly priceRial: string
  /** Null when the shop has no photograph; the card draws bread instead. */
  readonly imageUrl: string | null
  /** Baked on the order rather than sealed on a shelf. */
  readonly fresh: boolean
}

export interface CatalogShelf {
  readonly id: string
  readonly titleFa: string
  readonly noteFa: string
  readonly ratio: 'wide' | 'tall'
  readonly products: readonly ShelfProduct[]
}

export interface CatalogChip {
  readonly code: string
  readonly labelFa: string
}

export interface CatalogView {
  readonly shelves: readonly CatalogShelf[]
  readonly chips: readonly CatalogChip[]
  readonly total: number
}

/** The chip every shop opens on. A storefront that opens filtered hides itself. */
export const ALL_CATEGORIES = 'all'

/**
 * Photographs, until the shop has its own.
 *
 * A product carries `mediaRef` when someone has uploaded a picture for it, and
 * that always wins. These are the fallbacks for the launch range, from the
 * brand's design board: correct bread, correct crop, shot for a mock-up. A slug
 * with no entry here gets no photograph at all rather than a wrong one — the
 * card draws a loaf instead, which is honest, where showing sangak under the
 * name "لواش" would not be.
 */
const FALLBACK_IMAGES: Readonly<Record<string, string>> = {
  'komaj-gerdooyi': '/products/komaj-gerdooyi.jpg',
  'sangak-konjedi': '/products/sangak-konjedi.jpg',
  'barbari-konjedi': '/products/barbari-konjedi.jpg',
  lavash: '/products/lavash-packaged.jpg',
  taftoon: '/products/taftoon-packaged.jpg',
  sangak: '/products/sangak-packaged.jpg',
  barbari: '/products/barbari-packaged.jpg',
}

const FRESH_CLASS = 'SIGNATURE_FRESH'

export function isFresh(product: Pick<ProductSummary, 'fulfillmentClass'>): boolean {
  return product.fulfillmentClass === FRESH_CLASS
}

/**
 * The image for one bread.
 *
 * A `mediaRef` is only used when it is a path or an https URL. The value comes
 * out of the database, and a relative string like `javascript:` or a `data:`
 * blob reaching an `<img src>` is not something to find out about in
 * production.
 */
export function productImage(product: Pick<ProductSummary, 'slug' | 'mediaRef'>): string | null {
  const reference = product.mediaRef
  if (reference && (reference.startsWith('/') || reference.startsWith('https://'))) {
    return reference
  }
  return FALLBACK_IMAGES[product.slug] ?? null
}

export function toShelfProduct(product: ProductSummary): ShelfProduct {
  return {
    offeringId: product.offeringId,
    slug: product.slug,
    nameFa: product.nameFa,
    categoryCode: product.categoryCode,
    priceRial: product.price.amount,
    imageUrl: productImage(product),
    fresh: isFresh(product),
  }
}

/**
 * Splits the catalog into the two shelves the storefront is built around.
 *
 * Fresh bakes first: they are the reason to order from a bakery rather than a
 * shop, they are the most expensive thing on the page, and they are the only
 * things whose availability depends on the hour. Either shelf is dropped
 * entirely when it has nothing on it, so a shop selling only packaged bread
 * does not show an empty "پخت‌های ویژه".
 */
export function buildCatalogView(products: readonly ProductSummary[]): CatalogView {
  const fresh: ShelfProduct[] = []
  const packaged: ShelfProduct[] = []
  for (const product of products) {
    ;(isFresh(product) ? fresh : packaged).push(toShelfProduct(product))
  }

  const shelves: CatalogShelf[] = []
  if (fresh.length > 0) {
    shelves.push({
      id: 'special',
      titleFa: 'پخت‌های ویژه',
      noteFa: 'به صورت تازه و داغ',
      ratio: 'wide',
      products: fresh,
    })
  }
  if (packaged.length > 0) {
    shelves.push({
      id: 'everyday',
      titleFa: 'نان روزمره بسته‌بندی‌شده',
      noteFa: 'بسته‌بندی بهداشتی',
      ratio: 'tall',
      products: packaged,
    })
  }

  return { shelves, chips: buildChips(products), total: products.length }
}

/**
 * The chips, in the order the shelves introduce them.
 *
 * Ordering by first appearance rather than alphabetically means the rail reads
 * top-to-bottom the way the page does, and the chips a customer meets first are
 * the ones for the bread at the top. Duplicates collapse: one category holding
 * four breads is still one chip.
 */
function buildChips(products: readonly ProductSummary[]): CatalogChip[] {
  const seen = new Map<string, string>()
  for (const product of [...products].sort((a, b) => Number(isFresh(b)) - Number(isFresh(a)))) {
    if (!seen.has(product.categoryCode)) seen.set(product.categoryCode, product.categoryNameFa)
  }
  // Only worth a rail when there is something to choose between.
  if (seen.size < 2) return []
  return [
    { code: ALL_CATEGORIES, labelFa: 'همه' },
    ...[...seen].map(([code, labelFa]) => ({ code, labelFa })),
  ]
}
