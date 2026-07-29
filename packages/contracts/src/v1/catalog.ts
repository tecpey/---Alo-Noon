import { z } from 'zod'

import {
  moneySchema,
  paginationMetaSchema,
  paginationParamsSchema,
  responseMetaSchema,
  uuidSchema,
} from './common'

export const productFulfillmentClassSchema = z.enum([
  'SIGNATURE_FRESH',
  'PACKAGED_TRADITIONAL',
  'PACKAGED_FANTASY',
  'PACKAGED_DIETARY',
  'LIMITED_EDITION',
])
export const freshnessClaimSchema = z.enum(['FRESHLY_PRODUCED', 'PACKAGED', 'SHELF_STABLE', 'NONE'])
export const productLifecycleSchema = z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'])

export const productSummarySchema = z.object({
  id: uuidSchema,
  variantId: uuidSchema,
  sku: z.string().min(3).max(64),
  nameFa: z.string().min(1).max(200),
  fulfillmentClass: productFulfillmentClassSchema,
  freshnessClaim: freshnessClaimSchema,
  price: moneySchema,
  bakeryBranchId: uuidSchema.optional(),
  mediaRef: z.string().max(500).optional(),
  lifecycle: productLifecycleSchema,
})
export type ProductSummary = z.infer<typeof productSummarySchema>

export const productDetailSchema = productSummarySchema.extend({
  descriptionFa: z.string().max(2_000).optional(),
  ingredients: z.array(z.string().min(1).max(120)).max(100),
  allergens: z.array(z.string().min(1).max(120)).max(50),
  dietaryAttributes: z.array(z.string().min(1).max(80)).max(50),
  packaging: z
    .object({
      type: z.enum(['ALO_NOON_SEALED', 'PARTNER_SEALED', 'MANUFACTURER_PACKAGED']),
      shelfLifeMinutes: z.number().int().positive(),
    })
    .optional(),
  freshnessWindowMinutes: z.number().int().positive().optional(),
})
export type ProductDetail = z.infer<typeof productDetailSchema>

export const bakeryBranchSummarySchema = z.object({
  id: uuidSchema,
  bakeryId: uuidSchema,
  cityId: uuidSchema,
  operationalZoneId: uuidSchema,
  nameFa: z.string().min(1).max(200),
  status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED']),
  qualityStatus: z.enum(['PENDING_REVIEW', 'APPROVED', 'WATCHLIST', 'SUSPENDED']),
})
export type BakeryBranchSummary = z.infer<typeof bakeryBranchSummarySchema>

export const catalogListQuerySchema = paginationParamsSchema
  .pick({ page: true, pageSize: true })
  .extend({
    cityId: uuidSchema,
    operationalZoneId: uuidSchema.optional(),
  })
export type CatalogListQuery = z.infer<typeof catalogListQuerySchema>

export const catalogPageSchema = z.object({
  success: z.literal(true),
  data: z.array(productSummarySchema),
  meta: responseMetaSchema.extend({
    pagination: paginationMetaSchema,
  }),
})
export type CatalogPageContract = z.infer<typeof catalogPageSchema>
