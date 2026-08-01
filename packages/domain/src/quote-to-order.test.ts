import { describe, expect, it } from 'vitest'

import { authorizeQuoteToOrder, type QuoteToOrderCandidate } from './quote-to-order'

const now = new Date('2026-08-01T12:00:00.000Z')

function candidate(overrides: Partial<QuoteToOrderCandidate> = {}): QuoteToOrderCandidate {
  return {
    tenantId: 'tenant-a',
    customerId: 'customer-a',
    expectedTenantId: 'tenant-a',
    expectedCustomerId: 'customer-a',
    status: 'ACTIVE',
    expiresAt: new Date('2026-08-01T12:10:00.000Z'),
    currency: 'IRR',
    subtotalAmount: 100_000n,
    deliveryFeeAmount: 20_000n,
    discountAmount: 5_000n,
    totalAmount: 115_000n,
    deliveryAddressId: 'address-a',
    deliveryPricingRuleId: 'rule-a',
    deliveryPricingRuleVersion: 3,
    recipientNameSnapshot: 'Customer',
    recipientPhoneSnapshot: '+989111111111',
    deliveryAddressSnapshot: 'Verified delivery address',
    deliveryLatitudeSnapshot: '36.5387',
    deliveryLongitudeSnapshot: '52.6765',
    itemCount: 1,
    existingOrderId: null,
    ...overrides,
  }
}

describe('Quote-to-Order authorization', () => {
  it('authorizes a complete active quote owned by the tenant customer', () => {
    expect(authorizeQuoteToOrder(candidate(), now)).toEqual({
      tenantId: 'tenant-a',
      customerId: 'customer-a',
      deliveryAddressId: 'address-a',
      deliveryPricingRuleId: 'rule-a',
      deliveryPricingRuleVersion: 3,
      totalAmount: 115_000n,
      currency: 'IRR',
    })
  })

  it.each([
    [{ expectedTenantId: 'tenant-b' }, 'QUOTE_OWNERSHIP_MISMATCH'],
    [{ expectedCustomerId: 'customer-b' }, 'QUOTE_OWNERSHIP_MISMATCH'],
    [{ status: 'SUPERSEDED' as const }, 'QUOTE_NOT_ACTIVE'],
    [{ expiresAt: now }, 'QUOTE_EXPIRED'],
    [{ existingOrderId: 'order-a' }, 'QUOTE_ALREADY_ACCEPTED'],
    [{ itemCount: 0 }, 'QUOTE_EMPTY'],
    [{ deliveryAddressId: null }, 'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE'],
    [{ deliveryPricingRuleId: null }, 'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE'],
    [{ deliveryPricingRuleVersion: 0 }, 'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE'],
    [{ recipientPhoneSnapshot: ' ' }, 'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE'],
    [{ deliveryLatitudeSnapshot: null }, 'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE'],
    [{ totalAmount: 114_999n }, 'QUOTE_TOTAL_MISMATCH'],
    [{ discountAmount: 120_001n }, 'QUOTE_TOTAL_MISMATCH'],
    [{ deliveryFeeAmount: -1n }, 'QUOTE_TOTAL_MISMATCH'],
  ])('fails closed with the expected domain error', (override, code) => {
    expect(() => authorizeQuoteToOrder(candidate(override), now)).toThrow(
      expect.objectContaining({ code }),
    )
  })
})
