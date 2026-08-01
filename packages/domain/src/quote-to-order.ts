import { DomainError } from './errors'

export interface QuoteToOrderCandidate {
  tenantId: string
  customerId: string
  expectedTenantId: string
  expectedCustomerId: string
  status: 'ACTIVE' | 'SUPERSEDED' | 'EXPIRED' | 'ACCEPTED'
  expiresAt: Date
  currency: 'IRR'
  subtotalAmount: bigint
  deliveryFeeAmount: bigint
  discountAmount: bigint
  totalAmount: bigint
  deliveryAddressId: string | null
  deliveryPricingRuleId: string | null
  deliveryPricingRuleVersion: number | null
  recipientNameSnapshot: string | null
  recipientPhoneSnapshot: string | null
  deliveryAddressSnapshot: string | null
  deliveryLatitudeSnapshot: unknown | null
  deliveryLongitudeSnapshot: unknown | null
  itemCount: number
  existingOrderId: string | null
}

export interface QuoteToOrderDecision {
  tenantId: string
  customerId: string
  deliveryAddressId: string
  deliveryPricingRuleId: string
  deliveryPricingRuleVersion: number
  totalAmount: bigint
  currency: 'IRR'
}

export function authorizeQuoteToOrder(
  candidate: QuoteToOrderCandidate,
  evaluatedAt: Date,
): Readonly<QuoteToOrderDecision> {
  if (Number.isNaN(evaluatedAt.getTime())) {
    throw new DomainError('INVALID_QUOTE_TIME', 'Quote evaluation time must be valid')
  }
  if (
    candidate.tenantId !== candidate.expectedTenantId ||
    candidate.customerId !== candidate.expectedCustomerId
  ) {
    throw new DomainError('QUOTE_OWNERSHIP_MISMATCH', 'Quote ownership does not match')
  }
  if (candidate.existingOrderId) {
    throw new DomainError('QUOTE_ALREADY_ACCEPTED', 'Quote already produced an order')
  }
  if (candidate.status !== 'ACTIVE') {
    throw new DomainError('QUOTE_NOT_ACTIVE', 'Only an active quote can produce an order')
  }
  if (candidate.expiresAt <= evaluatedAt) {
    throw new DomainError('QUOTE_EXPIRED', 'Quote expired before order conversion')
  }
  if (candidate.itemCount < 1) {
    throw new DomainError('QUOTE_EMPTY', 'Quote must contain at least one item')
  }

  const requiredSnapshots = [
    candidate.deliveryAddressId,
    candidate.deliveryPricingRuleId,
    candidate.recipientNameSnapshot,
    candidate.recipientPhoneSnapshot,
    candidate.deliveryAddressSnapshot,
    candidate.deliveryLatitudeSnapshot,
    candidate.deliveryLongitudeSnapshot,
  ]
  if (
    requiredSnapshots.some(
      (value) => value === null || (typeof value === 'string' && !value.trim()),
    ) ||
    candidate.deliveryPricingRuleVersion === null ||
    !Number.isSafeInteger(candidate.deliveryPricingRuleVersion) ||
    candidate.deliveryPricingRuleVersion < 1
  ) {
    throw new DomainError(
      'QUOTE_DELIVERY_SNAPSHOT_INCOMPLETE',
      'Quote delivery snapshot is incomplete',
    )
  }

  if (
    candidate.subtotalAmount < 0n ||
    candidate.deliveryFeeAmount < 0n ||
    candidate.discountAmount < 0n ||
    candidate.totalAmount < 0n ||
    candidate.discountAmount > candidate.subtotalAmount + candidate.deliveryFeeAmount ||
    candidate.totalAmount !==
      candidate.subtotalAmount + candidate.deliveryFeeAmount - candidate.discountAmount
  ) {
    throw new DomainError('QUOTE_TOTAL_MISMATCH', 'Quote monetary snapshot is inconsistent')
  }

  return Object.freeze({
    tenantId: candidate.tenantId,
    customerId: candidate.customerId,
    deliveryAddressId: candidate.deliveryAddressId!,
    deliveryPricingRuleId: candidate.deliveryPricingRuleId!,
    deliveryPricingRuleVersion: candidate.deliveryPricingRuleVersion,
    totalAmount: candidate.totalAmount,
    currency: candidate.currency,
  })
}
