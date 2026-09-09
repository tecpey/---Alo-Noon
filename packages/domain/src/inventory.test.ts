import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  assertStockAvailable,
  decrementOfferingStock,
  validateOfferingStockShape,
  type OfferingStockShape,
} from './inventory'

describe('offering stock shape', () => {
  it.each<OfferingStockShape>([
    { stockTracked: false, stockOnHand: null },
    { stockTracked: true, stockOnHand: 0 },
    { stockTracked: true, stockOnHand: 42 },
  ])('accepts valid shapes', (shape) => {
    expect(validateOfferingStockShape(shape)).toEqual(shape)
  })

  it.each<OfferingStockShape>([
    { stockTracked: false, stockOnHand: 0 },
    { stockTracked: true, stockOnHand: null },
    { stockTracked: true, stockOnHand: -1 },
  ])('rejects mismatched tracking/quantity pairs', (shape) => {
    expect(() => validateOfferingStockShape(shape)).toThrowError(DomainError)
  })
})

describe('offering stock decrement', () => {
  it('decrements when enough stock is available', () => {
    expect(decrementOfferingStock(10, 3)).toBe(7)
    expect(decrementOfferingStock(5, 5)).toBe(0)
  })

  it('rejects a decrement larger than stock on hand', () => {
    expect(() => decrementOfferingStock(2, 3)).toThrowError(DomainError)
    try {
      decrementOfferingStock(2, 3)
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('OFFERING_STOCK_UNAVAILABLE')
    }
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer quantity: %s', (quantity) => {
    expect(() => assertStockAvailable(10, quantity)).toThrowError(DomainError)
  })

  it('rejects a negative stockOnHand as an invalid shape rather than unavailable stock', () => {
    expect(() => assertStockAvailable(-1, 1)).toThrowError(DomainError)
    try {
      assertStockAvailable(-1, 1)
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_OFFERING_STOCK_SHAPE')
    }
  })
})
