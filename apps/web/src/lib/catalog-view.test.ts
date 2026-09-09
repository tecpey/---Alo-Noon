import { describe, expect, it } from 'vitest'

import type { ProductSummary } from '@alo-noon/contracts'

import { ALL_CATEGORIES, buildCatalogView, productImage, toShelfProduct } from './catalog-view'

const CITY = '99999999-9999-4999-8999-999999999999'

let counter = 0
function product(overrides: Partial<ProductSummary> = {}): ProductSummary {
  counter += 1
  const pad = String(counter).padStart(12, '0')
  return {
    id: `11111111-1111-4111-8111-${pad}`,
    offeringId: `22222222-2222-4222-8222-${pad}`,
    variantId: `33333333-3333-4333-8333-${pad}`,
    sku: `SKU-${counter}`,
    slug: `bread-${counter}`,
    nameFa: 'نان',
    categoryCode: 'BARBARI',
    categoryNameFa: 'بربری',
    operationalZoneId: '44444444-4444-4444-8444-444444444444',
    fulfillmentClass: 'PACKAGED_TRADITIONAL',
    freshnessClaim: 'PACKAGED',
    price: { amount: '60000', currency: 'IRR' },
    lifecycle: 'ACTIVE',
    ...overrides,
  }
}

describe('buildCatalogView', () => {
  it('puts fresh bakes on the first shelf and packaged bread on the second', () => {
    const view = buildCatalogView(
      [
        product({ slug: 'lavash' }),
        product({
          slug: 'komaj',
          fulfillmentClass: 'SIGNATURE_FRESH',
          freshnessClaim: 'FRESHLY_PRODUCED',
        }),
      ],
      CITY,
    )

    expect(view.shelves.map((shelf) => shelf.id)).toEqual(['special', 'everyday'])
    expect(view.shelves[0]?.products.map((entry) => entry.slug)).toEqual(['komaj'])
    expect(view.shelves[1]?.products.map((entry) => entry.slug)).toEqual(['lavash'])
  })

  /**
   * A shop that sells only packaged bread should not advertise a "پخت‌های ویژه"
   * shelf with nothing on it.
   */
  it('drops a shelf that has nothing on it', () => {
    const view = buildCatalogView([product(), product()], CITY)
    expect(view.shelves.map((shelf) => shelf.id)).toEqual(['everyday'])
  })

  it('has no shelves at all for an empty catalog', () => {
    expect(buildCatalogView([], CITY).shelves).toEqual([])
  })

  it('derives one chip per category actually on sale, "همه" first', () => {
    const view = buildCatalogView(
      [
        product({ categoryCode: 'LAVASH', categoryNameFa: 'لواش' }),
        product({ categoryCode: 'BARBARI', categoryNameFa: 'بربری' }),
        product({ categoryCode: 'BARBARI', categoryNameFa: 'بربری' }),
      ],
      CITY,
    )

    expect(view.chips).toEqual([
      { code: ALL_CATEGORIES, labelFa: 'همه' },
      { code: 'LAVASH', labelFa: 'لواش' },
      { code: 'BARBARI', labelFa: 'بربری' },
    ])
  })

  it('introduces categories in the order the shelves reach them', () => {
    // The packaged bread is listed first, but the fresh shelf renders above it,
    // so its category has to be the first chip.
    const view = buildCatalogView(
      [
        product({ categoryCode: 'LAVASH', categoryNameFa: 'لواش' }),
        product({
          categoryCode: 'SWEET',
          categoryNameFa: 'شیرینی',
          fulfillmentClass: 'SIGNATURE_FRESH',
          freshnessClaim: 'FRESHLY_PRODUCED',
        }),
      ],
      CITY,
    )

    expect(view.chips.map((chip) => chip.code)).toEqual([ALL_CATEGORIES, 'SWEET', 'LAVASH'])
  })

  it('draws no rail when everything is in one category', () => {
    const view = buildCatalogView([product(), product()], CITY)
    expect(view.chips).toEqual([])
  })
})

describe('productImage', () => {
  it('prefers the shop’s own uploaded picture', () => {
    expect(productImage({ slug: 'lavash', mediaRef: '/media/lavash-real.jpg' })).toBe(
      '/media/lavash-real.jpg',
    )
  })

  it('falls back to the launch photograph for a known bread', () => {
    expect(productImage({ slug: 'lavash' })).toBe('/products/lavash-packaged.jpg')
  })

  /** A wrong photograph is worse than none: it misdescribes what is being sold. */
  it('shows no photograph for a bread it has none for', () => {
    expect(productImage({ slug: 'nan-e-taze' })).toBeNull()
  })

  it('refuses a media reference that is not a path or an https url', () => {
    expect(productImage({ slug: 'lavash', mediaRef: 'javascript:alert(1)' })).toBe(
      '/products/lavash-packaged.jpg',
    )
    expect(
      productImage({ slug: 'unknown-bread', mediaRef: 'data:image/png;base64,AAAA' }),
    ).toBeNull()
  })
})

describe('toShelfProduct', () => {
  it('keys the basket line on the offering, not the product', () => {
    const summary = product({ slug: 'sangak' })
    expect(toShelfProduct(summary, CITY).offeringId).toBe(summary.offeringId)
  })

  it('carries the price through as the ledger holds it', () => {
    const shelf = toShelfProduct(product({ price: { amount: '280000', currency: 'IRR' } }), CITY)
    // Rial, undivided. A Toman value here would be a tenth of the real price.
    expect(shelf.priceRial).toBe('280000')
    expect(shelf.priceRial).toMatch(/^\d+$/)
  })

  it('marks a signature bake as fresh and a sealed one as not', () => {
    expect(
      toShelfProduct(
        product({ fulfillmentClass: 'SIGNATURE_FRESH', freshnessClaim: 'FRESHLY_PRODUCED' }),
        CITY,
      ).fresh,
    ).toBe(true)
    expect(toShelfProduct(product(), CITY).fresh).toBe(false)
  })
})
