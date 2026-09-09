import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import type {
  AdminBranch,
  AdminOffering,
  AdminOfferingListQuery,
  AdminProduct,
  AdminProductListQuery,
  AdminVariant,
  CatalogCategory,
  CreateCatalogCategoryCommand,
  CreateOfferingCommand,
  CreateProductCommand,
  CreateVariantCommand,
  UpdateOfferingCommand,
  UpdateProductCommand,
  UpdateVariantCommand,
} from '@alo-noon/contracts'
import {
  ADMIN_PERMISSIONS,
  DomainError,
  validateOfferingStockShape,
  validateProductClassification,
  type ProductClassification,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'

/**
 * Catalogue authoring and branch pricing for staff.
 *
 * The split between a *variant* and an *offering* is the whole design. A variant
 * is what the bread is — its classification, its ingredients, the claim it makes
 * about freshness. An offering is one branch's decision to sell that variant at
 * one price. Retiring a variant withdraws it everywhere; pausing an offering
 * takes one branch out of the catalogue and leaves the rest selling.
 *
 * Nothing here reaches back into a placed order. Order lines carry their own
 * price, name, and SKU snapshots taken when the quote was accepted, so a price
 * raised this afternoon cannot alter an order taken this morning. That is a
 * property of the order schema, not of care taken here, and it is what makes
 * editing prices safe at all.
 */
export interface CatalogActor {
  accountId: string
}

export class AdminCatalogError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
  ) {
    super(code)
    this.name = 'AdminCatalogError'
  }
}

export interface AdminCatalogService {
  listCategories(tenantId: string): Promise<CatalogCategory[]>
  createCategory(
    tenantId: string,
    actor: CatalogActor,
    command: CreateCatalogCategoryCommand,
    now: Date,
    correlationId: string,
  ): Promise<CatalogCategory>

  listProducts(
    tenantId: string,
    query: AdminProductListQuery,
  ): Promise<{ products: AdminProduct[]; totalItems: number }>
  findProduct(tenantId: string, productId: string): Promise<AdminProduct | null>
  createProduct(
    tenantId: string,
    actor: CatalogActor,
    command: CreateProductCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminProduct>
  updateProduct(
    tenantId: string,
    actor: CatalogActor,
    productId: string,
    command: UpdateProductCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminProduct>

  createVariant(
    tenantId: string,
    actor: CatalogActor,
    productId: string,
    command: CreateVariantCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminVariant>
  updateVariant(
    tenantId: string,
    actor: CatalogActor,
    variantId: string,
    command: UpdateVariantCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminVariant>

  listBranches(tenantId: string): Promise<AdminBranch[]>
  listOfferings(
    tenantId: string,
    query: AdminOfferingListQuery,
  ): Promise<{ offerings: AdminOffering[]; totalItems: number }>
  createOffering(
    tenantId: string,
    actor: CatalogActor,
    command: CreateOfferingCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminOffering>
  updateOffering(
    tenantId: string,
    actor: CatalogActor,
    offeringId: string,
    command: UpdateOfferingCommand,
    now: Date,
    correlationId: string,
  ): Promise<AdminOffering>
}

/**
 * Lifecycles a catalogue row may move between.
 *
 * RETIRED is terminal. Bringing a retired product back would resurrect a name
 * and SKU that reports, order snapshots, and customers' order history already
 * treat as finished; if the bakery sells it again, it is a new row.
 */
const LIFECYCLE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['SUSPENDED', 'RETIRED'],
  SUSPENDED: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
}

/** Offering states in which a customer can actually buy. */
const SELLABLE_AVAILABILITY: readonly string[] = ['AVAILABLE', 'SOLD_OUT']

export function createPrismaAdminCatalogService(prisma: PrismaClient): AdminCatalogService {
  return {
    async listCategories(tenantId) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const rows = await transaction.productCategory.findMany({
          where: { tenantId },
          orderBy: { code: 'asc' },
          select: {
            id: true,
            code: true,
            nameFa: true,
            _count: { select: { products: true } },
          },
        })
        return rows.map((row) => ({
          id: row.id,
          code: row.code,
          nameFa: row.nameFa,
          productCount: row._count.products,
        }))
      })
    },

    async createCategory(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        // The code is globally unique in the schema, not per tenant, so a clash
        // is reported rather than left to surface as a constraint violation.
        const clash = await transaction.productCategory.findFirst({
          where: { code: command.code },
          select: { id: true },
        })
        if (clash) throw new AdminCatalogError('CATEGORY_CODE_TAKEN', 409)

        const created = await transaction.productCategory.create({
          data: {
            tenantId,
            code: command.code,
            nameFa: command.nameFa,
            createdAt: now,
            updatedAt: now,
          },
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.category_created',
          entityType: 'product_category',
          entityId: created.id,
          summary: `Category ${created.code} created`,
          payload: { code: created.code, nameFa: created.nameFa },
          correlationId,
          now,
        })
        return { id: created.id, code: created.code, nameFa: created.nameFa, productCount: 0 }
      })
    },

    async listProducts(tenantId, query) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const where = productFilter(tenantId, query)
        const [rows, totalItems] = await Promise.all([
          transaction.product.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            include: {
              category: { select: { nameFa: true } },
              variants: {
                orderBy: { sku: 'asc' },
                include: { _count: { select: { offerings: true } } },
              },
            },
          }),
          transaction.product.count({ where }),
        ])
        return { products: rows.map(mapProduct), totalItems }
      })
    },

    async findProduct(tenantId, productId) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const row = await transaction.product.findFirst({
          where: { id: productId, tenantId },
          include: {
            category: { select: { nameFa: true } },
            variants: {
              orderBy: { sku: 'asc' },
              include: { _count: { select: { offerings: true } } },
            },
          },
        })
        return row ? mapProduct(row) : null
      })
    },

    async createProduct(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const category = await transaction.productCategory.findFirst({
          where: { id: command.categoryId, tenantId },
          select: { id: true, nameFa: true },
        })
        if (!category) throw new AdminCatalogError('CATEGORY_NOT_FOUND', 404)

        const clash = await transaction.product.findFirst({
          where: { slug: command.slug },
          select: { id: true },
        })
        if (clash) throw new AdminCatalogError('PRODUCT_SLUG_TAKEN', 409)

        const created = await transaction.product.create({
          data: {
            tenantId,
            categoryId: category.id,
            slug: command.slug,
            nameFa: command.nameFa,
            ...(command.descriptionFa !== undefined && { descriptionFa: command.descriptionFa }),
            ...(command.mediaRef !== undefined && { mediaRef: command.mediaRef }),
            // Everything starts as a draft. A product that went live the moment
            // it was named would be sellable before anyone priced it.
            lifecycle: 'DRAFT',
            createdAt: now,
            updatedAt: now,
          },
          include: {
            category: { select: { nameFa: true } },
            variants: {
              orderBy: { sku: 'asc' },
              include: { _count: { select: { offerings: true } } },
            },
          },
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.product_created',
          entityType: 'product',
          entityId: created.id,
          summary: `Product ${created.slug} created`,
          payload: { slug: created.slug, nameFa: created.nameFa, categoryId: category.id },
          correlationId,
          now,
        })
        return mapProduct(created)
      })
    },

    async updateProduct(tenantId, actor, productId, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const existing = await transaction.product.findFirst({
          where: { id: productId, tenantId },
          select: { id: true, lifecycle: true, slug: true },
        })
        if (!existing) throw new AdminCatalogError('PRODUCT_NOT_FOUND', 404)
        if (command.lifecycle) assertLifecycleTransition(existing.lifecycle, command.lifecycle)

        // Retiring a product must not leave its variants for sale under it; the
        // catalogue would still show them and the product page would not exist.
        if (command.lifecycle === 'RETIRED') {
          await assertNoSellableOfferings(transaction, tenantId, { productId: existing.id })
        }

        const updated = await transaction.product.update({
          where: { id: existing.id },
          data: {
            ...(command.nameFa !== undefined && { nameFa: command.nameFa }),
            ...(command.descriptionFa !== undefined && { descriptionFa: command.descriptionFa }),
            ...(command.mediaRef !== undefined && { mediaRef: command.mediaRef }),
            ...(command.lifecycle !== undefined && { lifecycle: command.lifecycle }),
            updatedAt: now,
          },
          include: {
            category: { select: { nameFa: true } },
            variants: {
              orderBy: { sku: 'asc' },
              include: { _count: { select: { offerings: true } } },
            },
          },
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.product_updated',
          entityType: 'product',
          entityId: updated.id,
          summary: `Product ${updated.slug} updated`,
          payload: {
            slug: updated.slug,
            ...(command.lifecycle && {
              fromLifecycle: existing.lifecycle,
              toLifecycle: command.lifecycle,
            }),
            ...(command.reason && { reason: command.reason }),
          },
          correlationId,
          now,
        })
        return mapProduct(updated)
      })
    },

    async createVariant(tenantId, actor, productId, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const product = await transaction.product.findFirst({
          where: { id: productId, tenantId },
          select: { id: true, lifecycle: true },
        })
        if (!product) throw new AdminCatalogError('PRODUCT_NOT_FOUND', 404)
        if (product.lifecycle === 'RETIRED') {
          throw new AdminCatalogError('PRODUCT_RETIRED', 409)
        }

        const clash = await transaction.productVariant.findFirst({
          where: { sku: command.sku },
          select: { id: true },
        })
        if (clash) throw new AdminCatalogError('VARIANT_SKU_TAKEN', 409)

        // The domain owns the rule, not this module: a SIGNATURE_FRESH product
        // that does not claim freshness, or a packaged one with no shelf life,
        // is refused here for exactly the same reason it is refused at checkout.
        classify(command)

        const created = await transaction.productVariant.create({
          data: {
            tenantId,
            productId: product.id,
            sku: command.sku,
            nameFa: command.nameFa,
            fulfillmentClass: command.fulfillmentClass,
            freshnessClaim: command.freshnessClaim,
            productionMode: command.productionMode,
            fulfillmentControl: command.fulfillmentControl,
            ...(command.packagingType !== undefined && { packagingType: command.packagingType }),
            ...(command.shelfLifeMinutes !== undefined && {
              shelfLifeMinutes: command.shelfLifeMinutes,
            }),
            ...(command.productionWindowMinutes !== undefined && {
              productionWindowMinutes: command.productionWindowMinutes,
            }),
            ...(command.pickupWithinMinutes !== undefined && {
              pickupWithinMinutes: command.pickupWithinMinutes,
            }),
            ...(command.freshnessWindowMinutes !== undefined && {
              freshnessWindowMinutes: command.freshnessWindowMinutes,
            }),
            ingredients: command.ingredients,
            allergens: command.allergens,
            dietaryAttributes: command.dietaryAttributes,
            lifecycle: 'DRAFT',
            createdAt: now,
            updatedAt: now,
          },
          include: { _count: { select: { offerings: true } } },
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.variant_created',
          entityType: 'product_variant',
          entityId: created.id,
          summary: `Variant ${created.sku} created`,
          payload: {
            sku: created.sku,
            productId: product.id,
            fulfillmentClass: created.fulfillmentClass,
            freshnessClaim: created.freshnessClaim,
          },
          correlationId,
          now,
        })
        return mapVariant(created)
      })
    },

    async updateVariant(tenantId, actor, variantId, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const existing = await transaction.productVariant.findFirst({
          where: { id: variantId, tenantId },
          select: { id: true, sku: true, lifecycle: true },
        })
        if (!existing) throw new AdminCatalogError('VARIANT_NOT_FOUND', 404)
        if (command.lifecycle) assertLifecycleTransition(existing.lifecycle, command.lifecycle)

        // Withdrawing a variant that branches are still selling would leave
        // offerings pointing at something no longer in the catalogue.
        if (command.lifecycle === 'RETIRED' || command.lifecycle === 'SUSPENDED') {
          await assertNoSellableOfferings(transaction, tenantId, { variantId: existing.id })
        }

        // Classification is not patchable. Those fields decide how the order
        // pipeline schedules, holds, and hands over the item; changing them
        // under live offerings would silently re-plan work already committed.
        const updated = await transaction.productVariant.update({
          where: { id: existing.id },
          data: {
            ...(command.nameFa !== undefined && { nameFa: command.nameFa }),
            ...(command.ingredients !== undefined && { ingredients: command.ingredients }),
            ...(command.allergens !== undefined && { allergens: command.allergens }),
            ...(command.dietaryAttributes !== undefined && {
              dietaryAttributes: command.dietaryAttributes,
            }),
            ...(command.lifecycle !== undefined && { lifecycle: command.lifecycle }),
            updatedAt: now,
          },
          include: { _count: { select: { offerings: true } } },
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.variant_updated',
          entityType: 'product_variant',
          entityId: updated.id,
          summary: `Variant ${updated.sku} updated`,
          payload: {
            sku: updated.sku,
            ...(command.lifecycle && {
              fromLifecycle: existing.lifecycle,
              toLifecycle: command.lifecycle,
            }),
            ...(command.reason && { reason: command.reason }),
          },
          correlationId,
          now,
        })
        return mapVariant(updated)
      })
    },

    async listBranches(tenantId) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const rows = await transaction.bakeryBranch.findMany({
          where: { tenantId },
          orderBy: [{ code: 'asc' }],
          include: {
            bakery: { select: { displayNameFa: true } },
            _count: { select: { offerings: true } },
          },
        })
        return rows.map((row) => ({
          id: row.id,
          bakeryId: row.bakeryId,
          bakeryNameFa: row.bakery.displayNameFa,
          cityId: row.cityId,
          code: row.code,
          nameFa: row.nameFa,
          operationalStatus: row.operationalStatus,
          qualityStatus: row.qualityStatus,
          offeringCount: row._count.offerings,
        }))
      })
    },

    async listOfferings(tenantId, query) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const where: Prisma.BakeryProductOfferingWhereInput = {
          tenantId,
          ...(query.bakeryBranchId && { bakeryBranchId: query.bakeryBranchId }),
          ...(query.productVariantId && { productVariantId: query.productVariantId }),
          ...(query.availability && { availability: query.availability }),
        }
        const [rows, totalItems] = await Promise.all([
          transaction.bakeryProductOffering.findMany({
            where,
            orderBy: [{ bakeryBranchId: 'asc' }, { createdAt: 'desc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            include: offeringInclude,
          }),
          transaction.bakeryProductOffering.count({ where }),
        ])
        return { offerings: rows.map(mapOffering), totalItems }
      })
    },

    async createOffering(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const [branch, variant] = await Promise.all([
          transaction.bakeryBranch.findFirst({
            where: { id: command.bakeryBranchId, tenantId },
            select: { id: true },
          }),
          transaction.productVariant.findFirst({
            where: { id: command.productVariantId, tenantId },
            select: { id: true, lifecycle: true },
          }),
        ])
        if (!branch) throw new AdminCatalogError('BRANCH_NOT_FOUND', 404)
        if (!variant) throw new AdminCatalogError('VARIANT_NOT_FOUND', 404)
        if (variant.lifecycle === 'RETIRED') throw new AdminCatalogError('VARIANT_RETIRED', 409)

        const existing = await transaction.bakeryProductOffering.findFirst({
          where: { bakeryBranchId: branch.id, productVariantId: variant.id },
          select: { id: true },
        })
        // One offering per branch per variant. A second one would give the same
        // bread two prices at the same counter, and the selector has no rule for
        // choosing between them.
        if (existing) throw new AdminCatalogError('OFFERING_ALREADY_EXISTS', 409)

        const stock = stockShape(command.stockTracked, command.stockOnHand ?? null)
        const created = await transaction.bakeryProductOffering.create({
          data: {
            tenantId,
            bakeryBranchId: branch.id,
            productVariantId: variant.id,
            priceAmount: BigInt(command.price),
            priceCurrency: 'IRR',
            // A new offering is never immediately for sale: price, capacity, and
            // preparation time all deserve a second look before customers see it.
            availability: 'DRAFT',
            ...(command.dailyCapacity !== undefined && { dailyCapacity: command.dailyCapacity }),
            ...(command.preparationMinutes !== undefined && {
              preparationMinutes: command.preparationMinutes,
            }),
            stockTracked: stock.stockTracked,
            stockOnHand: stock.stockOnHand,
            createdAt: now,
            updatedAt: now,
          },
          include: offeringInclude,
        })
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.offering_created',
          entityType: 'bakery_product_offering',
          entityId: created.id,
          summary: `Offering created for ${created.productVariant.sku}`,
          payload: {
            bakeryBranchId: branch.id,
            productVariantId: variant.id,
            price: command.price,
            reason: command.reason,
          },
          correlationId,
          now,
        })
        return mapOffering(created)
      })
    },

    async updateOffering(tenantId, actor, offeringId, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const existing = await transaction.bakeryProductOffering.findFirst({
          where: { id: offeringId, tenantId },
          include: offeringInclude,
        })
        if (!existing) throw new AdminCatalogError('OFFERING_NOT_FOUND', 404)
        if (existing.availability === 'RETIRED') {
          throw new AdminCatalogError('OFFERING_RETIRED', 409)
        }

        // Putting an offering on sale is the one change that needs the rest of
        // the catalogue to agree: a branch cannot sell a variant its product has
        // withdrawn, whatever the offering row says.
        if (command.availability && SELLABLE_AVAILABILITY.includes(command.availability)) {
          if (existing.productVariant.lifecycle !== 'ACTIVE') {
            throw new AdminCatalogError('VARIANT_NOT_ACTIVE', 409)
          }
          if (existing.productVariant.product.lifecycle !== 'ACTIVE') {
            throw new AdminCatalogError('PRODUCT_NOT_ACTIVE', 409)
          }
        }

        const stock = command.stock
          ? stockShape(command.stock.stockTracked, command.stock.stockOnHand)
          : undefined

        const updated = await transaction.bakeryProductOffering.update({
          where: { id: existing.id },
          data: {
            ...(command.price !== undefined && { priceAmount: BigInt(command.price) }),
            ...(command.availability !== undefined && { availability: command.availability }),
            ...(command.dailyCapacity !== undefined && { dailyCapacity: command.dailyCapacity }),
            ...(command.preparationMinutes !== undefined && {
              preparationMinutes: command.preparationMinutes,
            }),
            ...(stock && { stockTracked: stock.stockTracked, stockOnHand: stock.stockOnHand }),
            ...(command.availableFrom !== undefined && {
              availableFrom:
                command.availableFrom === null ? null : new Date(command.availableFrom),
            }),
            ...(command.availableUntil !== undefined && {
              availableUntil:
                command.availableUntil === null ? null : new Date(command.availableUntil),
            }),
            updatedAt: now,
          },
          include: offeringInclude,
        })

        // The old price is recorded alongside the new one. Reconciling a
        // customer complaint about a charge means knowing what the price was at
        // the time, and the offering row only ever holds the current one.
        await recordCatalogChange(transaction, tenantId, actor, {
          action: 'catalog.offering_updated',
          entityType: 'bakery_product_offering',
          entityId: updated.id,
          summary: `Offering for ${updated.productVariant.sku} updated`,
          payload: {
            reason: command.reason,
            ...(command.price !== undefined && {
              fromPrice: existing.priceAmount.toString(),
              toPrice: updated.priceAmount.toString(),
            }),
            ...(command.availability !== undefined && {
              fromAvailability: existing.availability,
              toAvailability: updated.availability,
            }),
            ...(stock && {
              fromStockOnHand: existing.stockOnHand,
              toStockOnHand: updated.stockOnHand,
            }),
          },
          correlationId,
          now,
        })
        return mapOffering(updated)
      })
    },
  }
}

const offeringInclude = {
  bakeryBranch: { select: { nameFa: true } },
  productVariant: {
    select: {
      sku: true,
      nameFa: true,
      lifecycle: true,
      product: { select: { nameFa: true, lifecycle: true } },
    },
  },
} satisfies Prisma.BakeryProductOfferingInclude

function productFilter(tenantId: string, query: AdminProductListQuery): Prisma.ProductWhereInput {
  return {
    tenantId,
    ...(query.categoryId && { categoryId: query.categoryId }),
    ...(query.lifecycle && { lifecycle: query.lifecycle }),
    ...(query.search && {
      OR: [
        { nameFa: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search.toLowerCase() } },
      ],
    }),
  }
}

function mapProduct(row: {
  id: string
  categoryId: string
  category: { nameFa: string }
  slug: string
  nameFa: string
  descriptionFa: string | null
  mediaRef: string | null
  lifecycle: string
  variants: Parameters<typeof mapVariant>[0][]
  createdAt: Date
  updatedAt: Date
}): AdminProduct {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryNameFa: row.category.nameFa,
    slug: row.slug,
    nameFa: row.nameFa,
    descriptionFa: row.descriptionFa,
    mediaRef: row.mediaRef,
    lifecycle: row.lifecycle as AdminProduct['lifecycle'],
    variants: row.variants.map(mapVariant),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function mapVariant(row: {
  id: string
  productId: string
  sku: string
  nameFa: string
  fulfillmentClass: string
  freshnessClaim: string
  productionMode: string
  fulfillmentControl: string
  packagingType: string | null
  shelfLifeMinutes: number | null
  productionWindowMinutes: number | null
  pickupWithinMinutes: number | null
  freshnessWindowMinutes: number | null
  ingredients: string[]
  allergens: string[]
  dietaryAttributes: string[]
  lifecycle: string
  _count: { offerings: number }
}): AdminVariant {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    nameFa: row.nameFa,
    fulfillmentClass: row.fulfillmentClass as AdminVariant['fulfillmentClass'],
    freshnessClaim: row.freshnessClaim as AdminVariant['freshnessClaim'],
    productionMode: row.productionMode as AdminVariant['productionMode'],
    fulfillmentControl: row.fulfillmentControl as AdminVariant['fulfillmentControl'],
    packagingType: row.packagingType as AdminVariant['packagingType'],
    shelfLifeMinutes: row.shelfLifeMinutes,
    productionWindowMinutes: row.productionWindowMinutes,
    pickupWithinMinutes: row.pickupWithinMinutes,
    freshnessWindowMinutes: row.freshnessWindowMinutes,
    ingredients: row.ingredients,
    allergens: row.allergens,
    dietaryAttributes: row.dietaryAttributes,
    lifecycle: row.lifecycle as AdminVariant['lifecycle'],
    offeringCount: row._count.offerings,
  }
}

function mapOffering(row: {
  id: string
  bakeryBranchId: string
  bakeryBranch: { nameFa: string }
  productVariantId: string
  productVariant: {
    sku: string
    nameFa: string
    lifecycle: string
    product: { nameFa: string }
  }
  priceAmount: bigint
  availability: string
  dailyCapacity: number | null
  preparationMinutes: number | null
  stockTracked: boolean
  stockOnHand: number | null
  availableFrom: Date | null
  availableUntil: Date | null
  updatedAt: Date
}): AdminOffering {
  return {
    id: row.id,
    bakeryBranchId: row.bakeryBranchId,
    branchNameFa: row.bakeryBranch.nameFa,
    productVariantId: row.productVariantId,
    sku: row.productVariant.sku,
    productNameFa: row.productVariant.product.nameFa,
    variantNameFa: row.productVariant.nameFa,
    variantLifecycle: row.productVariant.lifecycle as AdminOffering['variantLifecycle'],
    price: { amount: row.priceAmount.toString(), currency: 'IRR' },
    availability: row.availability as AdminOffering['availability'],
    dailyCapacity: row.dailyCapacity,
    preparationMinutes: row.preparationMinutes,
    stockTracked: row.stockTracked,
    stockOnHand: row.stockOnHand,
    availableFrom: row.availableFrom?.toISOString() ?? null,
    availableUntil: row.availableUntil?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function assertLifecycleTransition(from: string, to: string): void {
  if (from === to) return
  if (!LIFECYCLE_TRANSITIONS[from]?.includes(to)) {
    throw new AdminCatalogError('LIFECYCLE_TRANSITION_INVALID', 409)
  }
}

async function assertNoSellableOfferings(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  target: { productId?: string; variantId?: string },
): Promise<void> {
  const live = await transaction.bakeryProductOffering.count({
    where: {
      tenantId,
      availability: { in: ['AVAILABLE', 'SOLD_OUT'] },
      ...(target.variantId && { productVariantId: target.variantId }),
      ...(target.productId && { productVariant: { productId: target.productId } }),
    },
  })
  if (live > 0) throw new AdminCatalogError('OFFERINGS_STILL_LIVE', 409)
}

/** Runs the domain classification rule, restating its refusal as a 422. */
function classify(command: CreateVariantCommand): void {
  const classification: ProductClassification = {
    fulfillmentClass: command.fulfillmentClass,
    freshnessClaim: command.freshnessClaim,
    productionMode: command.productionMode,
    fulfillmentControl: command.fulfillmentControl,
    ...(command.productionWindowMinutes !== undefined &&
      command.pickupWithinMinutes !== undefined &&
      command.freshnessWindowMinutes !== undefined && {
        freshnessPolicy: {
          productionWindowMinutes: command.productionWindowMinutes,
          pickupWithinMinutes: command.pickupWithinMinutes,
          freshnessWindowMinutes: command.freshnessWindowMinutes,
        },
      }),
    ...(command.packagingType !== undefined &&
      command.shelfLifeMinutes !== undefined && {
        packagingPolicy: {
          type: command.packagingType,
          shelfLifeMinutes: command.shelfLifeMinutes,
        },
      }),
  }
  try {
    validateProductClassification(classification)
  } catch (error) {
    if (error instanceof DomainError) {
      throw new AdminCatalogError('PRODUCT_CLASSIFICATION_INVALID', 422)
    }
    throw error
  }
}

function stockShape(
  stockTracked: boolean,
  stockOnHand: number | null,
): { stockTracked: boolean; stockOnHand: number | null } {
  try {
    const validated = validateOfferingStockShape({ stockTracked, stockOnHand })
    return { stockTracked: validated.stockTracked, stockOnHand: validated.stockOnHand }
  } catch (error) {
    if (error instanceof DomainError) {
      throw new AdminCatalogError('OFFERING_STOCK_SHAPE_INVALID', 422)
    }
    throw error
  }
}

interface CatalogChange {
  action: string
  entityType: string
  entityId: string
  summary: string
  payload: Prisma.InputJsonObject
  correlationId: string
  now: Date
}

/**
 * Every catalogue write leaves an audit event and a domain event.
 *
 * The audit event answers "who changed this price and why" months later, when
 * the only other record is an order total nobody can explain. The outbox event
 * is how anything downstream — search indexes, a partner feed — learns the
 * catalogue moved, without this module knowing they exist.
 */
async function recordCatalogChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: CatalogActor,
  change: CatalogChange,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      action: change.action,
      entityType: change.entityType,
      entityId: change.entityId,
      summary: change.summary,
      correlationId: change.correlationId,
      occurredAt: change.now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: change.action,
      aggregateType: change.entityType,
      aggregateId: change.entityId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      correlationId: change.correlationId,
      // Catalogue changes carry no personal data — they record what the
      // business sells, not who bought it — so no consent basis applies.
      consentBasis: 'NOT_REQUIRED',
      payload: change.payload,
      occurredAt: change.now,
    },
  })
}

async function readTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * A catalogue write, with the acting account's permission re-checked against
 * live grant rows inside the same transaction as the change it authorizes.
 */
async function writeTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  actor: CatalogActor,
  now: Date,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        const permitted = await holdsPermissionInTransaction(
          transaction,
          tenantId,
          actor.accountId,
          ADMIN_PERMISSIONS.catalogManage,
          now,
        )
        if (!permitted) throw new AdminCatalogError('CATALOG_OPERATION_FORBIDDEN', 403)
        return operation(transaction)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object') {
      // A unique index we did not check first, or a serialization failure. Both
      // mean "someone else got there"; neither is an outage.
      const code = Reflect.get(error, 'code')
      if (code === 'P2002') throw new AdminCatalogError('CATALOG_WRITE_CONFLICT', 409)
      if (code === 'P2034') throw new AdminCatalogError('CATALOG_WRITE_CONFLICT', 409)
    }
    throw error
  }
}
