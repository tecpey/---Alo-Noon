import { describe, expect, it } from 'vitest'

import {
  createCatalogCategoryCommandSchema,
  createOfferingCommandSchema,
  createProductCommandSchema,
  createVariantCommandSchema,
  updateOfferingCommandSchema,
  updateProductCommandSchema,
} from './admin-catalog'

/**
 * These schemas are the last line before a mispriced or half-described product
 * reaches the database, so the cases below are the mistakes an operator actually
 * makes rather than a tour of Zod.
 */
describe('admin catalogue transport', () => {
  it('refuses a zero or negative price rather than treating it as free', () => {
    const base = {
      bakeryBranchId: '11111111-1111-4111-8111-111111111111',
      productVariantId: '22222222-2222-4222-8222-222222222222',
      stockTracked: false,
      reason: 'قیمت‌گذاری اولیه',
    }
    expect(createOfferingCommandSchema.safeParse({ ...base, price: '0' }).success).toBe(false)
    expect(createOfferingCommandSchema.safeParse({ ...base, price: '-500' }).success).toBe(false)
    expect(createOfferingCommandSchema.safeParse({ ...base, price: '250000' }).success).toBe(true)
  })

  it('carries a price as a string so a Rial amount survives the round trip', () => {
    const parsed = createOfferingCommandSchema.parse({
      bakeryBranchId: '11111111-1111-4111-8111-111111111111',
      productVariantId: '22222222-2222-4222-8222-222222222222',
      // Beyond Number.MAX_SAFE_INTEGER: a JSON number would have shifted it.
      price: '90071992547409931',
      stockTracked: false,
      reason: 'مبلغ بزرگ',
    })
    expect(parsed.price).toBe('90071992547409931')
  })

  it('requires stock on hand exactly when stock is tracked', () => {
    const base = {
      bakeryBranchId: '11111111-1111-4111-8111-111111111111',
      productVariantId: '22222222-2222-4222-8222-222222222222',
      price: '250000',
      reason: 'موجودی',
    }
    expect(createOfferingCommandSchema.safeParse({ ...base, stockTracked: true }).success).toBe(
      false,
    )
    expect(
      createOfferingCommandSchema.safeParse({ ...base, stockTracked: false, stockOnHand: 5 })
        .success,
    ).toBe(false)
    expect(
      createOfferingCommandSchema.safeParse({ ...base, stockTracked: true, stockOnHand: 5 })
        .success,
    ).toBe(true)
  })

  it('refuses a patch that changes nothing but carries a reason', () => {
    expect(updateProductCommandSchema.safeParse({ reason: 'چون' }).success).toBe(false)
    expect(updateProductCommandSchema.safeParse({ nameFa: 'نان تازه' }).success).toBe(true)
  })

  it('refuses an availability window that ends before it starts', () => {
    const result = updateOfferingCommandSchema.safeParse({
      availableFrom: '2026-08-08T10:00:00.000Z',
      availableUntil: '2026-08-08T06:00:00.000Z',
      reason: 'بازهٔ فروش',
    })
    expect(result.success).toBe(false)
  })

  it('accepts clearing an availability window with nulls', () => {
    const result = updateOfferingCommandSchema.safeParse({
      availableFrom: null,
      availableUntil: null,
      reason: 'حذف بازه',
    })
    expect(result.success).toBe(true)
  })

  it('keeps slugs and SKUs in their own casing so links and labels stay stable', () => {
    const product = { categoryId: '33333333-3333-4333-8333-333333333333', nameFa: 'بربری' }
    expect(createProductCommandSchema.safeParse({ ...product, slug: 'Barbari' }).success).toBe(
      false,
    )
    expect(createProductCommandSchema.safeParse({ ...product, slug: 'nan-barbari' }).success).toBe(
      true,
    )

    const variant = {
      nameFa: 'بربری ساده',
      fulfillmentClass: 'SIGNATURE_FRESH' as const,
      freshnessClaim: 'FRESHLY_PRODUCED' as const,
      productionMode: 'MADE_TO_ORDER' as const,
      fulfillmentControl: 'CONTROLLED_PICKUP' as const,
    }
    expect(createVariantCommandSchema.safeParse({ ...variant, sku: 'barbari-1' }).success).toBe(
      false,
    )
    expect(createVariantCommandSchema.safeParse({ ...variant, sku: 'BARBARI-1' }).success).toBe(
      true,
    )
  })

  it('defaults a variant to empty ingredient, allergen, and dietary lists', () => {
    const parsed = createVariantCommandSchema.parse({
      sku: 'SANGAK-1',
      nameFa: 'سنگک',
      fulfillmentClass: 'SIGNATURE_FRESH',
      freshnessClaim: 'FRESHLY_PRODUCED',
      productionMode: 'MADE_TO_ORDER',
      fulfillmentControl: 'CONTROLLED_PICKUP',
    })
    expect(parsed.ingredients).toEqual([])
    expect(parsed.allergens).toEqual([])
    expect(parsed.dietaryAttributes).toEqual([])
  })

  it('rejects unknown fields rather than silently dropping them', () => {
    const result = createCatalogCategoryCommandSchema.safeParse({
      code: 'TRADITIONAL',
      nameFa: 'سنتی',
      isDefault: true,
    })
    expect(result.success).toBe(false)
  })
})
