import { z } from 'zod'

import { freshnessClaimSchema, productFulfillmentClassSchema } from './catalog'
import { isoDateTimeSchema, moneySchema, responseMetaSchema, uuidSchema } from './common'

export const cartItemMutationSchema = z.object({
  cityId: uuidSchema,
  operationalZoneId: uuidSchema,
  quantity: z.number().int().min(1).max(100),
  expectedCartVersion: z.number().int().min(1).optional(),
})
export type CartItemMutation = z.infer<typeof cartItemMutationSchema>

export const cartItemRemovalSchema = z.object({
  expectedCartVersion: z.number().int().min(1).optional(),
})
export type CartItemRemoval = z.infer<typeof cartItemRemovalSchema>

export const quoteCreateSchema = z.object({
  deliveryAddressId: uuidSchema,
  expectedCartVersion: z.number().int().min(1),
  idempotencyKey: z.string().trim().min(16).max(128),
  /**
   * A discount code, as the customer typed it.
   *
   * Optional, and a bad one does not fail the quote: a basket that refuses to
   * price because a code expired is a basket the customer abandons. The quote
   * comes back without the discount and says why separately.
   */
  promotionCode: z.string().trim().min(1).max(64).optional(),
})
export type QuoteCreate = z.infer<typeof quoteCreateSchema>

export const commerceItemSnapshotSchema = z.object({
  id: uuidSchema,
  bakeryProductOfferingId: uuidSchema,
  productVariantId: uuidSchema,
  bakeryBranchId: uuidSchema,
  sku: z.string().min(1).max(64),
  nameFa: z.string().min(1),
  fulfillmentClass: productFulfillmentClassSchema,
  freshnessClaim: freshnessClaimSchema,
  quantity: z.number().int().min(1).max(100),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})
export type CommerceItemSnapshot = z.infer<typeof commerceItemSnapshotSchema>

export const cartSummarySchema = z.object({
  id: uuidSchema,
  cityId: uuidSchema,
  operationalZoneId: uuidSchema,
  bakeryBranchId: uuidSchema,
  version: z.number().int().min(1),
  subtotal: moneySchema,
  items: z.array(commerceItemSnapshotSchema),
  updatedAt: isoDateTimeSchema,
})
export type CartSummary = z.infer<typeof cartSummarySchema>

export const cartEnvelopeSchema = z.object({
  success: z.literal(true),
  data: cartSummarySchema.nullable(),
  meta: responseMetaSchema,
})
export type CartEnvelope = z.infer<typeof cartEnvelopeSchema>

export const quoteStatusSchema = z.enum(['ACTIVE', 'SUPERSEDED', 'EXPIRED', 'ACCEPTED'])

export const quoteSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(8).max(32),
  cartId: uuidSchema,
  cartVersion: z.number().int().min(1),
  status: quoteStatusSchema,
  expiresAt: isoDateTimeSchema,
  deliveryAddressId: uuidSchema,
  deliveryServiceAreaId: uuidSchema,
  deliveryOperationalZoneId: uuidSchema,
  deliveryDistanceMeters: z.number().int().min(0),
  deliveryPricingRuleId: uuidSchema,
  deliveryPricingRuleVersion: z.number().int().min(1),
  subtotal: moneySchema,
  deliveryFee: moneySchema,
  discount: moneySchema,
  /** The campaign that produced the discount, when one did. */
  promotion: z
    .object({
      nameFa: z.string().min(1).max(200),
      basis: z.enum(['SUBTOTAL', 'DELIVERY_FEE']),
    })
    .optional(),
  /** Why a code the customer supplied did nothing. Absent when it worked. */
  promotionRefusal: z.string().min(1).max(64).optional(),
  total: moneySchema,
  items: z.array(commerceItemSnapshotSchema).min(1),
  createdAt: isoDateTimeSchema,
})
export type QuoteSummary = z.infer<typeof quoteSummarySchema>

export const quoteEnvelopeSchema = z.object({
  success: z.literal(true),
  data: quoteSummarySchema,
  meta: responseMetaSchema,
})
export type QuoteEnvelope = z.infer<typeof quoteEnvelopeSchema>
