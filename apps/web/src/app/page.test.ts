import { describe, expect, it } from 'vitest'

import { foundationStatus } from './page'
import {
  categories,
  everydayBreads,
  heroCopy,
  specialBakes,
  trustClaims,
} from '../lib/storefront-content'

describe('storefront', () => {
  it('exposes the foundation status in Persian', () => {
    expect(foundationStatus).toContain('آماده')
  })

  it('prices every product in Rial, as the ledger holds it', () => {
    // A price written in Toman here would be a tenth of itself the moment this
    // page is wired to the real catalog.
    for (const product of [...specialBakes.products, ...everydayBreads.products]) {
      expect(product.priceRial).toMatch(/^\d+$/)
      expect(BigInt(product.priceRial)).toBeGreaterThan(0n)
    }
  })

  it('gives every photograph alternative text describing the bread', () => {
    for (const product of [...specialBakes.products, ...everydayBreads.products]) {
      expect(product.imageAlt.length).toBeGreaterThan(4)
      expect(product.imageAlt).not.toBe(product.nameFa)
    }
  })

  it('keeps the headline in the two lines the artwork sets', () => {
    expect(heroCopy.headlineFa).toHaveLength(2)
  })
})

describe('the category rail', () => {
  it('has a chip for every category a product claims', () => {
    // A product filed under a category with no chip is a product the filter can
    // permanently hide.
    const chips = new Set(categories.map((category) => category.id))
    for (const product of [...specialBakes.products, ...everydayBreads.products]) {
      expect(chips.has(product.categoryId)).toBe(true)
    }
  })

  it('opens on a chip that hides nothing', () => {
    expect(categories[0]?.id).toBe('all')
  })

  it('leaves no chip that matches nothing at all', () => {
    // A filter that can only ever produce an empty page is a filter that should
    // not be on the page.
    const used = new Set(
      [...specialBakes.products, ...everydayBreads.products].map((product) => product.categoryId),
    )
    for (const category of categories) {
      if (category.id === 'all') continue
      expect(used.has(category.id)).toBe(true)
    }
  })
})

describe('what the storefront claims', () => {
  it('backs every trust claim with a sentence rather than a slogan', () => {
    for (const claim of trustClaims) {
      expect(claim.bodyFa.length).toBeGreaterThan(20)
    }
  })
})
