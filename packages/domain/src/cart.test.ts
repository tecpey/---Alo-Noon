import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { Money } from './money'
import {
  QUOTE_TTL_MS,
  assertCartMutationContext,
  calculateCartLine,
  calculateQuoteExpiry,
} from './cart'

const context = {
  cityId: 'city-1',
  operationalZoneId: 'zone-1',
  bakeryBranchId: 'branch-1',
  version: 4,
  offeringCityId: 'city-1',
  offeringOperationalZoneId: 'zone-1',
  offeringBakeryBranchId: 'branch-1',
}

describe('cart and quote invariants', () => {
  it('calculates exact integer line totals', () => {
    expect(calculateCartLine(Money.irr('250000'), 3).toJSON()).toEqual({
      amount: '750000',
      currency: 'IRR',
    })
  })

  it('rejects invalid quantities, stale versions, and mixed fulfillment contexts', () => {
    expect(() => calculateCartLine(Money.irr(1), 0)).toThrowError(DomainError)
    expect(() => calculateCartLine(Money.irr(1), 101)).toThrowError(DomainError)
    expect(() => assertCartMutationContext({ ...context, expectedVersion: 3 })).toThrowError(
      DomainError,
    )
    expect(() =>
      assertCartMutationContext({ ...context, offeringBakeryBranchId: 'branch-2' }),
    ).toThrowError(DomainError)
  })

  it('creates a bounded quote expiry without mutating input time', () => {
    const now = new Date('2026-07-29T12:00:00.000Z')
    expect(calculateQuoteExpiry(now).getTime()).toBe(now.getTime() + QUOTE_TTL_MS)
    expect(now.toISOString()).toBe('2026-07-29T12:00:00.000Z')
  })
})
