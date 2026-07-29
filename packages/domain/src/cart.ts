import { DomainError } from './errors'
import type { Money } from './money'

export const MAX_CART_ITEM_QUANTITY = 100
export const QUOTE_TTL_MS = 10 * 60 * 1000

export interface CartContext {
  cityId: string
  operationalZoneId: string
  bakeryBranchId: string
  version: number
}

export interface CartMutationContext extends CartContext {
  expectedVersion?: number
  offeringCityId: string
  offeringOperationalZoneId: string
  offeringBakeryBranchId: string
}

export function assertCartMutationContext(input: CartMutationContext): void {
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.version) {
    throw new DomainError('CART_VERSION_CONFLICT', 'Cart was changed by another request')
  }
  if (
    input.cityId !== input.offeringCityId ||
    input.operationalZoneId !== input.offeringOperationalZoneId ||
    input.bakeryBranchId !== input.offeringBakeryBranchId
  ) {
    throw new DomainError(
      'CART_CONTEXT_MISMATCH',
      'Cart items must belong to one city, operational zone, and bakery branch',
    )
  }
}

export function calculateCartLine(unitPrice: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_CART_ITEM_QUANTITY) {
    throw new DomainError(
      'INVALID_CART_QUANTITY',
      `Cart quantity must be between 1 and ${MAX_CART_ITEM_QUANTITY}`,
    )
  }
  return unitPrice.multiply(quantity)
}

export function calculateQuoteExpiry(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new DomainError('INVALID_QUOTE_TIME', 'Quote creation time must be valid')
  }
  return new Date(now.getTime() + QUOTE_TTL_MS)
}
