import { z } from 'zod'

import {
  freshnessClaimSchema,
  productFulfillmentClassSchema,
  productLifecycleSchema,
} from './catalog'
import { isoDateTimeSchema, moneySchema, uuidSchema } from './common'

/**
 * Staff-facing catalogue authoring and pricing transport.
 *
 * Two different things live here and they are deliberately kept apart. A
 * *product* and its *variants* describe what the bread is — its name, its
 * classification, what is in it. An *offering* is a branch's decision to sell a
 * given variant at a given price. The same variant offered by two branches is
 * two offerings with two prices, and a bakery leaving the platform withdraws its
 * offerings without touching the product catalogue.
 *
 * Prices are IRR minor units carried as decimal strings for the same reason
 * every other money field in this API is: a Rial price exceeds what a JSON
 * number holds exactly once it passes a few million.
 *
 * Changing an offering's price never rewrites an order. Order lines carry their
 * own price snapshot taken at quote time, so a price raised this afternoon
 * cannot reach into an order placed this morning.
 */
export const offeringAvailabilitySchema = z.enum([
  'DRAFT',
  'AVAILABLE',
  'PAUSED',
  'SOLD_OUT',
  'RETIRED',
])

export const productionModeSchema = z.enum([
  'MADE_TO_ORDER',
  'SCHEDULED_BATCH',
  'READY_STOCK',
  'EXTERNAL_PACKAGED_SUPPLY',
])

export const fulfillmentControlSchema = z.enum([
  'CONTROLLED_PICKUP',
  'PARTNER_HANDOFF',
  'PLATFORM_STOCK',
  'THIRD_PARTY_SUPPLY',
])

export const packagingTypeSchema = z.enum([
  'ALO_NOON_SEALED',
  'PARTNER_SEALED',
  'MANUFACTURER_PACKAGED',
])

/**
 * A price is a positive integral number of Rial. Zero is refused rather than
 * treated as "free": a free line has never been intended in this catalogue, and
 * accepting it silently would be how a mispriced offering ships.
 */
const priceAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/, 'Price must be a positive whole number of Rial')

const reasonSchema = z.string().min(3).max(280)

/** Slugs and SKUs address a row from outside; keep them boring and stable. */
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words and hyphens')
const skuSchema = z.string().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Use uppercase words and hyphens')

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const catalogCategorySchema = z.object({
  id: uuidSchema,
  code: z.string().min(2).max(32),
  nameFa: z.string().min(1).max(200),
  productCount: z.number().int().min(0),
})

export const createCatalogCategoryCommandSchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/, 'Use uppercase words and underscores')
      .max(32),
    nameFa: z.string().min(1).max(200),
  })
  .strict()

// ---------------------------------------------------------------------------
// Products and variants
// ---------------------------------------------------------------------------

export const adminVariantSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema,
  sku: skuSchema.max(64),
  nameFa: z.string().min(1).max(200),
  fulfillmentClass: productFulfillmentClassSchema,
  freshnessClaim: freshnessClaimSchema,
  productionMode: productionModeSchema,
  fulfillmentControl: fulfillmentControlSchema,
  packagingType: packagingTypeSchema.nullable(),
  shelfLifeMinutes: z.number().int().positive().nullable(),
  productionWindowMinutes: z.number().int().positive().nullable(),
  pickupWithinMinutes: z.number().int().positive().nullable(),
  freshnessWindowMinutes: z.number().int().positive().nullable(),
  ingredients: z.array(z.string().min(1).max(120)),
  allergens: z.array(z.string().min(1).max(120)),
  dietaryAttributes: z.array(z.string().min(1).max(80)),
  lifecycle: productLifecycleSchema,
  /** How many branches currently offer this variant, in any availability. */
  offeringCount: z.number().int().min(0),
})

export const adminProductSchema = z.object({
  id: uuidSchema,
  categoryId: uuidSchema,
  categoryNameFa: z.string().min(1).max(200),
  slug: slugSchema.max(100),
  nameFa: z.string().min(1).max(200),
  descriptionFa: z.string().nullable(),
  mediaRef: z.string().max(500).nullable(),
  lifecycle: productLifecycleSchema,
  variants: z.array(adminVariantSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const adminProductListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    categoryId: uuidSchema.optional(),
    lifecycle: productLifecycleSchema.optional(),
    /** Case-insensitive match on the Persian name or the slug. */
    search: z.string().min(2).max(120).optional(),
  })
  .strict()

export const createProductCommandSchema = z
  .object({
    categoryId: uuidSchema,
    slug: slugSchema.min(3).max(100),
    nameFa: z.string().min(1).max(200),
    descriptionFa: z.string().max(2_000).optional(),
    mediaRef: z.string().max(500).optional(),
  })
  .strict()

/**
 * Every field is optional because this is a patch, but an empty patch is
 * refused: a request that changes nothing and reports success is how an
 * operator concludes they saved work they did not save.
 */
export const updateProductCommandSchema = z
  .object({
    nameFa: z.string().min(1).max(200).optional(),
    descriptionFa: z.string().max(2_000).nullable().optional(),
    mediaRef: z.string().max(500).nullable().optional(),
    lifecycle: productLifecycleSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).some((key) => key !== 'reason'), {
    message: 'A product update must change at least one field',
  })

/**
 * Classification fields are required together because the domain validates them
 * as a set: a freshness claim is only meaningful against a fulfillment class,
 * and a packaged class without packaging is not a half-filled form but an
 * invalid product.
 */
export const createVariantCommandSchema = z
  .object({
    sku: skuSchema.min(3).max(64),
    nameFa: z.string().min(1).max(200),
    fulfillmentClass: productFulfillmentClassSchema,
    freshnessClaim: freshnessClaimSchema,
    productionMode: productionModeSchema,
    fulfillmentControl: fulfillmentControlSchema,
    packagingType: packagingTypeSchema.optional(),
    shelfLifeMinutes: z.number().int().positive().max(525_600).optional(),
    productionWindowMinutes: z.number().int().positive().max(1_440).optional(),
    pickupWithinMinutes: z.number().int().positive().max(1_440).optional(),
    freshnessWindowMinutes: z.number().int().positive().max(1_440).optional(),
    ingredients: z.array(z.string().min(1).max(120)).max(100).default([]),
    allergens: z.array(z.string().min(1).max(120)).max(50).default([]),
    dietaryAttributes: z.array(z.string().min(1).max(80)).max(50).default([]),
  })
  .strict()

export const updateVariantCommandSchema = z
  .object({
    nameFa: z.string().min(1).max(200).optional(),
    ingredients: z.array(z.string().min(1).max(120)).max(100).optional(),
    allergens: z.array(z.string().min(1).max(120)).max(50).optional(),
    dietaryAttributes: z.array(z.string().min(1).max(80)).max(50).optional(),
    lifecycle: productLifecycleSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).some((key) => key !== 'reason'), {
    message: 'A variant update must change at least one field',
  })

// ---------------------------------------------------------------------------
// Branches and offerings
// ---------------------------------------------------------------------------

export const adminBranchSchema = z.object({
  id: uuidSchema,
  bakeryId: uuidSchema,
  bakeryNameFa: z.string().min(1).max(200),
  cityId: uuidSchema,
  code: z.string().min(1).max(32),
  nameFa: z.string().min(1).max(200),
  operationalStatus: z.enum(['ONBOARDING', 'ACTIVE', 'TEMPORARILY_SUSPENDED', 'CLOSED']),
  qualityStatus: z.enum(['PENDING_REVIEW', 'APPROVED', 'WATCHLIST', 'SUSPENDED']),
  offeringCount: z.number().int().min(0),
})

export const adminOfferingSchema = z.object({
  id: uuidSchema,
  bakeryBranchId: uuidSchema,
  branchNameFa: z.string().min(1).max(200),
  productVariantId: uuidSchema,
  sku: skuSchema.max(64),
  productNameFa: z.string().min(1).max(200),
  variantNameFa: z.string().min(1).max(200),
  variantLifecycle: productLifecycleSchema,
  price: moneySchema,
  availability: offeringAvailabilitySchema,
  dailyCapacity: z.number().int().positive().nullable(),
  preparationMinutes: z.number().int().positive().nullable(),
  stockTracked: z.boolean(),
  stockOnHand: z.number().int().min(0).nullable(),
  availableFrom: isoDateTimeSchema.nullable(),
  availableUntil: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
})

export const adminOfferingListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    bakeryBranchId: uuidSchema.optional(),
    productVariantId: uuidSchema.optional(),
    availability: offeringAvailabilitySchema.optional(),
  })
  .strict()

/**
 * Stock is a pair, never a lone number: `stockTracked` says whether this
 * offering counts units at all, and `stockOnHand` must be present exactly when
 * it does. The domain refuses every other combination, and the transport says
 * so here rather than letting a half-set pair reach the database.
 */
const stockShapeSchema = z
  .object({
    stockTracked: z.boolean(),
    stockOnHand: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .refine((stock) => stock.stockTracked === (stock.stockOnHand !== null), {
    message: 'stockOnHand must be set exactly when stockTracked is true',
  })

export const createOfferingCommandSchema = z
  .object({
    bakeryBranchId: uuidSchema,
    productVariantId: uuidSchema,
    price: priceAmountSchema,
    dailyCapacity: z.number().int().positive().max(100_000).optional(),
    preparationMinutes: z.number().int().positive().max(1_440).optional(),
    stockTracked: z.boolean().default(false),
    stockOnHand: z.number().int().min(0).max(1_000_000).optional(),
    reason: reasonSchema,
  })
  .strict()
  .refine((command) => command.stockTracked === (command.stockOnHand !== undefined), {
    message: 'stockOnHand must be set exactly when stockTracked is true',
  })

/**
 * A price change and an availability change are the same command on purpose:
 * an operator correcting a mispriced offering usually pauses it in the same
 * breath, and splitting the two would leave a window where the wrong price is
 * live.
 */
export const updateOfferingCommandSchema = z
  .object({
    price: priceAmountSchema.optional(),
    availability: offeringAvailabilitySchema.optional(),
    dailyCapacity: z.number().int().positive().max(100_000).nullable().optional(),
    preparationMinutes: z.number().int().positive().max(1_440).nullable().optional(),
    stock: stockShapeSchema.optional(),
    availableFrom: isoDateTimeSchema.nullable().optional(),
    availableUntil: isoDateTimeSchema.nullable().optional(),
    reason: reasonSchema,
  })
  .strict()
  .refine((patch) => Object.keys(patch).some((key) => key !== 'reason'), {
    message: 'An offering update must change at least one field',
  })
  .refine(
    (patch) =>
      !patch.availableFrom ||
      !patch.availableUntil ||
      new Date(patch.availableFrom) < new Date(patch.availableUntil),
    { message: 'An offering window must start before it ends' },
  )

export type CatalogCategory = z.infer<typeof catalogCategorySchema>
export type CreateCatalogCategoryCommand = z.infer<typeof createCatalogCategoryCommandSchema>
export type AdminProduct = z.infer<typeof adminProductSchema>
export type AdminVariant = z.infer<typeof adminVariantSchema>
export type AdminProductListQuery = z.infer<typeof adminProductListQuerySchema>
export type CreateProductCommand = z.infer<typeof createProductCommandSchema>
export type UpdateProductCommand = z.infer<typeof updateProductCommandSchema>
export type CreateVariantCommand = z.infer<typeof createVariantCommandSchema>
export type UpdateVariantCommand = z.infer<typeof updateVariantCommandSchema>
export type AdminBranch = z.infer<typeof adminBranchSchema>
export type AdminOffering = z.infer<typeof adminOfferingSchema>
export type AdminOfferingListQuery = z.infer<typeof adminOfferingListQuerySchema>
export type CreateOfferingCommand = z.infer<typeof createOfferingCommandSchema>
export type UpdateOfferingCommand = z.infer<typeof updateOfferingCommandSchema>
