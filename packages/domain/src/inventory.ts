import { DomainError } from './errors'

/**
 * SIGNATURE_FRESH offerings use dailyCapacity/BakeryCapacitySlot, a production
 * schedule reservation, not a stock count. This models the separate ready-stock
 * counter for packaged offerings (ProductionMode.READY_STOCK): a discrete
 * quantity on hand that is decremented per unit sold.
 */
export interface OfferingStockShape {
  stockTracked: boolean
  stockOnHand: number | null
}

export function validateOfferingStockShape(
  input: OfferingStockShape,
): Readonly<OfferingStockShape> {
  if (!input.stockTracked) {
    if (input.stockOnHand !== null) {
      throw new DomainError(
        'INVALID_OFFERING_STOCK_SHAPE',
        'stockOnHand must be null unless stockTracked is true',
      )
    }
    return Object.freeze(input)
  }
  if (!Number.isSafeInteger(input.stockOnHand) || (input.stockOnHand as number) < 0) {
    throw new DomainError(
      'INVALID_OFFERING_STOCK_SHAPE',
      'stockOnHand must be a non-negative integer when stockTracked is true',
    )
  }
  return Object.freeze(input)
}

export function assertStockAvailable(stockOnHand: number, requestedQuantity: number): void {
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1) {
    throw new DomainError('INVALID_STOCK_QUANTITY', 'Requested quantity must be a positive integer')
  }
  if (!Number.isSafeInteger(stockOnHand) || stockOnHand < 0) {
    throw new DomainError(
      'INVALID_OFFERING_STOCK_SHAPE',
      'stockOnHand must be a non-negative integer',
    )
  }
  if (stockOnHand < requestedQuantity) {
    throw new DomainError(
      'OFFERING_STOCK_UNAVAILABLE',
      'Insufficient stock for the requested quantity',
      { stockOnHand, requestedQuantity },
    )
  }
}

/**
 * Pure representation of the decrement rule for unit testing. The concurrency-safe
 * enforcement at order acceptance is a single conditional SQL UPDATE (mirroring the
 * BakeryCapacitySlot reservation pattern), not a call through this function — a
 * read-then-write in application code cannot be race-safe under concurrent orders.
 */
export function decrementOfferingStock(stockOnHand: number, requestedQuantity: number): number {
  assertStockAvailable(stockOnHand, requestedQuantity)
  return stockOnHand - requestedQuantity
}
