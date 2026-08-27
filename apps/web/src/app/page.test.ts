import { describe, expect, it } from 'vitest'

import { foundationStatus } from './page'
import { everydayBreads, heroCopy, specialBakes } from '../lib/storefront-content'

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
