import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  adminOfferingListQuerySchema,
  adminProductListQuerySchema,
  createCatalogCategoryCommandSchema,
  createOfferingCommandSchema,
  createProductCommandSchema,
  createVariantCommandSchema,
  updateOfferingCommandSchema,
  updateProductCommandSchema,
  updateVariantCommandSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { AdminCatalogError, type AdminCatalogService } from './admin-catalog.js'

/**
 * Staff catalogue and pricing routes.
 *
 * Reads and writes are both gated on `admin.catalog.manage`. Separating a read
 * permission would only look finer-grained: everything readable here is either
 * already public in the customer catalogue or is a draft the same role is about
 * to publish.
 */
const CATALOG_PERMISSION = ADMIN_PERMISSIONS.catalogManage

// Catalogue writes are deliberate, human-paced acts. A budget this size still
// allows a bulk price update by hand while bounding a stolen session.
const CATALOG_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }

export interface AdminCatalogDependencies extends AdminAuthDependencies {
  service: AdminCatalogService
}

export function registerAdminCatalogRoutes(
  app: FastifyInstance,
  dependencies: AdminCatalogDependencies,
): void {
  const now = (): Date => dependencies.now?.() ?? new Date()

  app.get('/api/v1/admin/catalog/categories', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    try {
      const categories = await dependencies.service.listCategories(actor.tenantId)
      return reply.send({ success: true, data: categories, meta: adminResponseMeta() })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/catalog/categories', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    const parsed = createCatalogCategoryCommandSchema.safeParse(request.body)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_CATEGORY_COMMAND')

    try {
      const category = await dependencies.service.createCategory(
        actor.tenantId,
        { accountId: actor.accountId },
        parsed.data,
        now(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: category, meta: adminResponseMeta() })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.get('/api/v1/admin/catalog/products', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    const parsed = adminProductListQuerySchema.safeParse(request.query)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_PRODUCT_QUERY')

    try {
      const { products, totalItems } = await dependencies.service.listProducts(
        actor.tenantId,
        parsed.data,
      )
      return reply.send({
        success: true,
        data: products,
        meta: { ...adminResponseMeta(), pagination: paginationMeta(parsed.data, totalItems) },
      })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.get<{ Params: { productId: string } }>(
    '/api/v1/admin/catalog/products/:productId',
    CATALOG_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
      if (!actor) return reply
      try {
        const product = await dependencies.service.findProduct(
          actor.tenantId,
          request.params.productId,
        )
        if (!product) {
          return reply.code(404).send(errorEnvelope('PRODUCT_NOT_FOUND', 'No such product.'))
        }
        return reply.send({ success: true, data: product, meta: adminResponseMeta() })
      } catch (error) {
        return catalogFailure(request, reply, error)
      }
    },
  )

  app.post('/api/v1/admin/catalog/products', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    const parsed = createProductCommandSchema.safeParse(request.body)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_PRODUCT_COMMAND')

    try {
      const product = await dependencies.service.createProduct(
        actor.tenantId,
        { accountId: actor.accountId },
        parsed.data,
        now(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: product, meta: adminResponseMeta() })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.patch<{ Params: { productId: string } }>(
    '/api/v1/admin/catalog/products/:productId',
    CATALOG_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
      if (!actor) return reply
      const parsed = updateProductCommandSchema.safeParse(request.body)
      if (!parsed.success) return invalidCommand(reply, 'INVALID_PRODUCT_COMMAND')

      try {
        const product = await dependencies.service.updateProduct(
          actor.tenantId,
          { accountId: actor.accountId },
          request.params.productId,
          parsed.data,
          now(),
          randomUUID(),
        )
        return reply.send({ success: true, data: product, meta: adminResponseMeta() })
      } catch (error) {
        return catalogFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { productId: string } }>(
    '/api/v1/admin/catalog/products/:productId/variants',
    CATALOG_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
      if (!actor) return reply
      const parsed = createVariantCommandSchema.safeParse(request.body)
      if (!parsed.success) return invalidCommand(reply, 'INVALID_VARIANT_COMMAND')

      try {
        const variant = await dependencies.service.createVariant(
          actor.tenantId,
          { accountId: actor.accountId },
          request.params.productId,
          parsed.data,
          now(),
          randomUUID(),
        )
        return reply.code(201).send({ success: true, data: variant, meta: adminResponseMeta() })
      } catch (error) {
        return catalogFailure(request, reply, error)
      }
    },
  )

  app.patch<{ Params: { variantId: string } }>(
    '/api/v1/admin/catalog/variants/:variantId',
    CATALOG_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
      if (!actor) return reply
      const parsed = updateVariantCommandSchema.safeParse(request.body)
      if (!parsed.success) return invalidCommand(reply, 'INVALID_VARIANT_COMMAND')

      try {
        const variant = await dependencies.service.updateVariant(
          actor.tenantId,
          { accountId: actor.accountId },
          request.params.variantId,
          parsed.data,
          now(),
          randomUUID(),
        )
        return reply.send({ success: true, data: variant, meta: adminResponseMeta() })
      } catch (error) {
        return catalogFailure(request, reply, error)
      }
    },
  )

  app.get('/api/v1/admin/catalog/branches', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    try {
      const branches = await dependencies.service.listBranches(actor.tenantId)
      return reply.send({ success: true, data: branches, meta: adminResponseMeta() })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.get('/api/v1/admin/catalog/offerings', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    const parsed = adminOfferingListQuerySchema.safeParse(request.query)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_OFFERING_QUERY')

    try {
      const { offerings, totalItems } = await dependencies.service.listOfferings(
        actor.tenantId,
        parsed.data,
      )
      return reply.send({
        success: true,
        data: offerings,
        meta: { ...adminResponseMeta(), pagination: paginationMeta(parsed.data, totalItems) },
      })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/catalog/offerings', CATALOG_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
    if (!actor) return reply
    const parsed = createOfferingCommandSchema.safeParse(request.body)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_OFFERING_COMMAND')

    try {
      const offering = await dependencies.service.createOffering(
        actor.tenantId,
        { accountId: actor.accountId },
        parsed.data,
        now(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: offering, meta: adminResponseMeta() })
    } catch (error) {
      return catalogFailure(request, reply, error)
    }
  })

  app.patch<{ Params: { offeringId: string } }>(
    '/api/v1/admin/catalog/offerings/:offeringId',
    CATALOG_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, CATALOG_PERMISSION)
      if (!actor) return reply
      const parsed = updateOfferingCommandSchema.safeParse(request.body)
      if (!parsed.success) return invalidCommand(reply, 'INVALID_OFFERING_COMMAND')

      try {
        const offering = await dependencies.service.updateOffering(
          actor.tenantId,
          { accountId: actor.accountId },
          request.params.offeringId,
          parsed.data,
          now(),
          randomUUID(),
        )
        return reply.send({ success: true, data: offering, meta: adminResponseMeta() })
      } catch (error) {
        return catalogFailure(request, reply, error)
      }
    },
  )
}

function paginationMeta(
  query: { page: number; pageSize: number },
  totalItems: number,
): {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
} {
  const totalPages = Math.ceil(totalItems / query.pageSize)
  return {
    page: query.page,
    pageSize: query.pageSize,
    totalItems,
    totalPages,
    hasNextPage: query.page < totalPages,
    hasPreviousPage: query.page > 1,
  }
}

function invalidCommand(reply: FastifyReply, code: string): unknown {
  return reply.code(400).send(errorEnvelope(code, 'The command is invalid.'))
}

/**
 * Every refusal the service raises carries its own status, so the mapping is
 * the error itself rather than a table that can drift from it. Anything else is
 * an outage and is logged as one.
 */
function catalogFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AdminCatalogError) {
    return reply
      .code(error.status)
      .send(
        errorEnvelope(
          error.code,
          CATALOG_MESSAGES[error.code] ?? 'The catalogue operation was refused.',
        ),
      )
  }
  // A malformed UUID in the path reaches Postgres as a cast error, not an empty
  // result. Reporting it as an outage would blame the server for a bad link.
  if (isInvalidIdentifier(error)) {
    return reply
      .code(404)
      .send(errorEnvelope('CATALOG_ENTITY_NOT_FOUND', 'No such catalogue entry.'))
  }
  request.log.error({ err: error }, 'Admin catalogue operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('CATALOG_UNAVAILABLE', 'The catalogue is temporarily unavailable.'))
}

const CATALOG_MESSAGES: Readonly<Record<string, string>> = {
  CATALOG_OPERATION_FORBIDDEN: 'This account may not manage the catalogue.',
  CATEGORY_CODE_TAKEN: 'A category already uses that code.',
  CATEGORY_NOT_FOUND: 'No such category.',
  PRODUCT_SLUG_TAKEN: 'A product already uses that slug.',
  PRODUCT_NOT_FOUND: 'No such product.',
  PRODUCT_RETIRED: 'A retired product cannot gain new variants.',
  PRODUCT_NOT_ACTIVE: 'The product must be active before its variants can be sold.',
  VARIANT_SKU_TAKEN: 'A variant already uses that SKU.',
  VARIANT_NOT_FOUND: 'No such variant.',
  VARIANT_RETIRED: 'A retired variant cannot be offered.',
  VARIANT_NOT_ACTIVE: 'The variant must be active before it can be sold.',
  PRODUCT_CLASSIFICATION_INVALID: 'The product classification is not a valid combination.',
  LIFECYCLE_TRANSITION_INVALID: 'That lifecycle change is not allowed.',
  OFFERINGS_STILL_LIVE: 'Withdraw the live offerings first.',
  BRANCH_NOT_FOUND: 'No such branch.',
  OFFERING_NOT_FOUND: 'No such offering.',
  OFFERING_ALREADY_EXISTS: 'This branch already offers that variant.',
  OFFERING_RETIRED: 'A retired offering cannot be changed.',
  OFFERING_STOCK_SHAPE_INVALID: 'Stock on hand must be set exactly when stock is tracked.',
  CATALOG_WRITE_CONFLICT: 'Another change landed first. Reload and try again.',
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
