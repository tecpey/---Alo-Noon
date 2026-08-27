import { describe, expect, it } from 'vitest'

import {
  foundationStatus,
  heroCopy,
  orderConditions,
  orderSteps,
  trustClaims,
} from '../lib/storefront-content'

/**
 * What is left to test here is the writing.
 *
 * The bread used to live in this module, and these tests checked that every
 * product was priced in Rial and that every category had a chip. Both are now
 * structural rather than editorial — the catalog comes from the API and the
 * chips are derived from it, so `catalog-view.test.ts` holds those rules. What
 * remains is copy, and copy has its own ways of going wrong.
 */
describe('storefront copy', () => {
  it('exposes the foundation status in Persian', () => {
    expect(foundationStatus).toContain('آماده')
  })

  it('keeps the headline in the two lines the artwork sets', () => {
    expect(heroCopy.headlineFa).toHaveLength(2)
  })

  it('backs every trust claim with a sentence rather than a slogan', () => {
    for (const claim of trustClaims) {
      expect(claim.bodyFa.length).toBeGreaterThan(20)
    }
  })

  it('describes each ordering step as something the customer does', () => {
    expect(orderSteps).toHaveLength(3)
    for (const step of orderSteps) {
      expect(step.titleFa.length).toBeGreaterThan(0)
      expect(step.bodyFa.length).toBeGreaterThan(20)
    }
  })

  /**
   * The city field is filled from the catalog the page actually loaded, so its
   * placeholder must never be mistaken for a real answer if that lookup fails.
   */
  it('asks where, how and when — in that order', () => {
    expect(orderConditions.map((condition) => condition.id)).toEqual([
      'address',
      'method',
      'window',
    ])
  })
})
