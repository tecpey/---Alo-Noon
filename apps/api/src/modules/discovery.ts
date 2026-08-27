import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  activeCitySummarySchema,
  catalogDetailQuerySchema,
  catalogListQuerySchema,
  productDetailSchema,
  serviceabilityRequestSchema,
  type ActiveCitySummary,
  type ErrorEnvelope,
  type PaginatedResponse,
  type ProductDetail,
  type ProductSummary,
  type ResponseMeta,
  type ServiceabilityRequest,
  type ServiceabilityResponse,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'

import { resolveTenantId, type AuthDependencies } from './auth.js'

export interface CatalogListInput {
  cityId: string
  operationalZoneId?: string
  page: number
  pageSize: number
}

export interface CatalogPage {
  items: ProductSummary[]
  totalItems: number
}

export interface CatalogDetailInput {
  slug: string
  cityId: string
  operationalZoneId?: string
}

export interface CatalogRepository {
  listProducts(tenantId: string, input: CatalogListInput): Promise<CatalogPage>
  /** Null when the slug is unknown, or known but not on sale in this city. */
  findProduct(tenantId: string, input: CatalogDetailInput): Promise<ProductDetail | null>
}

export interface CityRepository {
  listActiveCities(tenantId: string): Promise<ActiveCitySummary[]>
}

export interface ServiceAreaRecord {
  id: string
  operationalZoneId: string
  areaActive: boolean
  zoneActive: boolean
  boundaryGeoJson: unknown
}

export interface ServiceabilityRepository {
  isCityActive(tenantId: string, cityId: string): Promise<boolean>
  listAreas(tenantId: string, cityId: string): Promise<ServiceAreaRecord[]>
}

export interface DiscoveryDependencies {
  catalogRepository: CatalogRepository
  cityRepository: CityRepository
  serviceabilityRepository: ServiceabilityRepository
  auth?: AuthDependencies
}

export function createPrismaCityRepository(prisma: PrismaClient): CityRepository {
  return {
    async listActiveCities(tenantId) {
      return withTenant(prisma, tenantId, (transaction) =>
        transaction.city.findMany({
          where: {
            tenantId,
            isActive: true,
            operationalZones: {
              some: {
                isActive: true,
                serviceAreas: { some: { isActive: true } },
              },
            },
          },
          select: {
            id: true,
            code: true,
            nameFa: true,
            timezone: true,
          },
          orderBy: [{ nameFa: 'asc' }, { id: 'asc' }],
        }),
      )
    },
  }
}

/**
 * What makes an offering something a customer may be shown.
 *
 * Written once and shared by the list and the single-product read, because the
 * two must agree: a bread on the shelf whose own page says it does not exist is
 * a worse bug than either query being wrong on its own, and the way that
 * happens is two copies of this predicate drifting apart.
 *
 * Every clause is a way the shop can be closed for one loaf — the offering
 * withdrawn, its window passed, the branch suspended or failing quality review,
 * the partner's agreement ended, the city or zone switched off, or the product
 * retired.
 */
function sellableOfferingWhere(
  tenantId: string,
  input: { cityId: string; operationalZoneId?: string },
  now: Date,
): Prisma.BakeryProductOfferingWhereInput {
  return {
    tenantId,
    availability: 'AVAILABLE',
    AND: [
      { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
      { OR: [{ availableUntil: null }, { availableUntil: { gte: now } }] },
    ],
    bakeryBranch: {
      is: {
        cityId: input.cityId,
        ...(input.operationalZoneId && { operationalZoneId: input.operationalZoneId }),
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
        bakery: { is: { partnerStatus: 'ACTIVE' } },
        city: { is: { isActive: true } },
        operationalZone: { is: { isActive: true } },
      },
    },
    productVariant: {
      is: {
        lifecycle: 'ACTIVE',
        product: { is: { lifecycle: 'ACTIVE' } },
      },
    },
  }
}

const OFFERING_INCLUDE = {
  bakeryBranch: true,
  // The category comes along on the same query rather than in a second pass:
  // the storefront groups by it, so fetching it later would mean one round trip
  // per bread on the shelf.
  productVariant: { include: { product: { include: { category: true } } } },
} as const

type OfferingRow = Prisma.BakeryProductOfferingGetPayload<{ include: typeof OFFERING_INCLUDE }>

function toProductSummary(offering: OfferingRow): ProductSummary {
  return {
    id: offering.productVariant.product.id,
    offeringId: offering.id,
    variantId: offering.productVariant.id,
    sku: offering.productVariant.sku,
    slug: offering.productVariant.product.slug,
    nameFa: offering.productVariant.product.nameFa,
    categoryCode: offering.productVariant.product.category.code,
    categoryNameFa: offering.productVariant.product.category.nameFa,
    fulfillmentClass: offering.productVariant.fulfillmentClass,
    freshnessClaim: offering.productVariant.freshnessClaim,
    price: {
      amount: offering.priceAmount.toString(),
      currency: offering.priceCurrency,
    },
    bakeryBranchId: offering.bakeryBranchId,
    ...(offering.productVariant.product.mediaRef && {
      mediaRef: offering.productVariant.product.mediaRef,
    }),
    lifecycle: offering.productVariant.lifecycle,
  }
}

export function createPrismaCatalogRepository(prisma: PrismaClient): CatalogRepository {
  return {
    async findProduct(tenantId, input) {
      const offering = await withTenant(prisma, tenantId, (transaction) =>
        transaction.bakeryProductOffering.findFirst({
          where: {
            ...sellableOfferingWhere(tenantId, input, new Date()),
            productVariant: {
              is: {
                lifecycle: 'ACTIVE',
                product: { is: { lifecycle: 'ACTIVE', slug: input.slug } },
              },
            },
          },
          include: OFFERING_INCLUDE,
          // The same bread may be offered by several branches in one city. The
          // oldest wins, which is the same order the shelf uses, so opening a
          // card shows the price that card quoted.
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      )
      if (!offering) return null

      const variant = offering.productVariant
      return {
        ...toProductSummary(offering),
        ...(variant.product.descriptionFa && { descriptionFa: variant.product.descriptionFa }),
        ingredients: variant.ingredients,
        allergens: variant.allergens,
        dietaryAttributes: variant.dietaryAttributes,
        ...(variant.packagingType &&
          variant.shelfLifeMinutes && {
            packaging: {
              type: variant.packagingType,
              shelfLifeMinutes: variant.shelfLifeMinutes,
            },
          }),
        ...(variant.freshnessWindowMinutes && {
          freshnessWindowMinutes: variant.freshnessWindowMinutes,
        }),
      }
    },

    async listProducts(tenantId, input) {
      const where = sellableOfferingWhere(tenantId, input, new Date())

      const [offerings, totalItems] = await withTenant(prisma, tenantId, async (transaction) =>
        Promise.all([
          transaction.bakeryProductOffering.findMany({
            where,
            include: OFFERING_INCLUDE,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            skip: (input.page - 1) * input.pageSize,
            take: input.pageSize,
          }),
          transaction.bakeryProductOffering.count({ where }),
        ]),
      )

      return { totalItems, items: offerings.map(toProductSummary) }
    },
  }
}

export function createPrismaServiceabilityRepository(
  prisma: PrismaClient,
): ServiceabilityRepository {
  return {
    async isCityActive(tenantId, cityId) {
      const city = await withTenant(prisma, tenantId, (transaction) =>
        transaction.city.findFirst({
          where: { id: cityId, tenantId },
          select: { isActive: true },
        }),
      )
      return city?.isActive ?? false
    },
    async listAreas(tenantId, cityId) {
      const areas = await withTenant(prisma, tenantId, (transaction) =>
        transaction.serviceArea.findMany({
          where: { tenantId, operationalZone: { is: { cityId, tenantId } } },
          select: {
            id: true,
            operationalZoneId: true,
            isActive: true,
            boundaryGeoJson: true,
            operationalZone: { select: { isActive: true } },
          },
          orderBy: [{ operationalZoneId: 'asc' }, { id: 'asc' }],
        }),
      )

      return areas.map((area) => ({
        id: area.id,
        operationalZoneId: area.operationalZoneId,
        areaActive: area.isActive,
        zoneActive: area.operationalZone.isActive,
        boundaryGeoJson: area.boundaryGeoJson,
      }))
    },
  }
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  dependencies: DiscoveryDependencies,
): void {
  app.get('/api/v1/serviceability/cities', async (request, reply) => {
    const tenantId = dependencies.auth ? await resolveTenantId(request, dependencies.auth) : null
    if (!tenantId) return tenantUnavailable(reply)
    try {
      const cities = activeCitySummarySchema
        .array()
        .parse(await dependencies.cityRepository.listActiveCities(tenantId))
      return {
        success: true,
        data: cities,
        meta: responseMeta(),
      }
    } catch (error) {
      request.log.error({ err: error }, 'Active city discovery failed')
      return reply
        .code(503)
        .send(
          errorEnvelope('CITY_DISCOVERY_UNAVAILABLE', 'City discovery is temporarily unavailable.'),
        )
    }
  })

  app.get('/api/v1/catalog/products', async (request, reply) => {
    const parsed = catalogListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            'INVALID_CATALOG_QUERY',
            'Catalog query parameters are invalid.',
            parsed.error.flatten(),
          ),
        )
    }
    const tenantId = dependencies.auth ? await resolveTenantId(request, dependencies.auth) : null
    if (!tenantId) return tenantUnavailable(reply)

    try {
      const input: CatalogListInput = {
        cityId: parsed.data.cityId,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        ...(parsed.data.operationalZoneId && {
          operationalZoneId: parsed.data.operationalZoneId,
        }),
      }
      const page = await dependencies.catalogRepository.listProducts(tenantId, input)
      const totalPages = Math.ceil(page.totalItems / input.pageSize)

      const response: PaginatedResponse<ProductSummary> = {
        success: true,
        data: page.items,
        meta: {
          ...responseMeta(),
          pagination: {
            page: parsed.data.page,
            pageSize: parsed.data.pageSize,
            totalItems: page.totalItems,
            totalPages,
            hasNextPage: parsed.data.page < totalPages,
            hasPreviousPage: parsed.data.page > 1,
          },
        },
      }
      return response
    } catch (error) {
      request.log.error({ err: error }, 'Catalog discovery failed')
      return reply
        .code(503)
        .send(errorEnvelope('CATALOG_UNAVAILABLE', 'Catalog is temporarily unavailable.'))
    }
  })

  /**
   * One product, by its public slug.
   *
   * Registered after the list route and with a distinct path shape, so
   * `/catalog/products` and `/catalog/products/sangak` cannot be confused.
   *
   * A slug that exists but is not on sale in this city answers 404 rather than
   * an empty 200: the customer followed a link to a bread, and "we do not have
   * this" is the answer, whether the reason is that it was never ours or that
   * this city's bakeries do not make it.
   */
  app.get<{ Params: { slug: string } }>(
    '/api/v1/catalog/products/:slug',
    async (request, reply) => {
      const parsed = catalogDetailQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'INVALID_CATALOG_QUERY',
              'Catalog query parameters are invalid.',
              parsed.error.flatten(),
            ),
          )
      }
      const tenantId = dependencies.auth ? await resolveTenantId(request, dependencies.auth) : null
      if (!tenantId) return tenantUnavailable(reply)

      try {
        const product = await dependencies.catalogRepository.findProduct(tenantId, {
          slug: request.params.slug,
          cityId: parsed.data.cityId,
          ...(parsed.data.operationalZoneId && {
            operationalZoneId: parsed.data.operationalZoneId,
          }),
        })
        if (!product) {
          return reply
            .code(404)
            .send(errorEnvelope('PRODUCT_NOT_FOUND', 'No such product is on sale in this city.'))
        }
        // Parsed on the way out, so a repository that grows a field the public
        // contract does not have cannot leak it to a customer.
        return {
          success: true,
          data: productDetailSchema.parse(product),
          meta: responseMeta(),
        }
      } catch (error) {
        request.log.error({ err: error }, 'Catalog product read failed')
        return reply
          .code(503)
          .send(errorEnvelope('CATALOG_UNAVAILABLE', 'Catalog is temporarily unavailable.'))
      }
    },
  )

  app.post('/api/v1/serviceability/check', async (request, reply) => {
    const parsed = serviceabilityRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            'INVALID_SERVICEABILITY_REQUEST',
            'Serviceability request is invalid.',
            parsed.error.flatten(),
          ),
        )
    }
    const tenantId = dependencies.auth ? await resolveTenantId(request, dependencies.auth) : null
    if (!tenantId) return tenantUnavailable(reply)

    try {
      const result = await evaluateServiceability(
        parsed.data,
        dependencies.serviceabilityRepository,
        tenantId,
      )
      return {
        success: true,
        data: result,
        meta: responseMeta(),
      }
    } catch (error) {
      request.log.error({ err: error }, 'Serviceability evaluation failed')
      return reply
        .code(503)
        .send(
          errorEnvelope('SERVICEABILITY_UNAVAILABLE', 'Serviceability is temporarily unavailable.'),
        )
    }
  })
}

export async function evaluateServiceability(
  input: ServiceabilityRequest,
  repository: ServiceabilityRepository,
  tenantId: string,
  now = new Date(),
): Promise<ServiceabilityResponse> {
  if (!(await repository.isCityActive(tenantId, input.cityId))) {
    return {
      serviceable: false,
      reason: 'OUTSIDE_CITY',
      evaluatedAt: now.toISOString(),
    }
  }

  const matches = (await repository.listAreas(tenantId, input.cityId)).filter((area) =>
    geoJsonContainsPoint(area.boundaryGeoJson, input.longitude, input.latitude),
  )
  const activeMatches = matches.filter((area) => area.areaActive && area.zoneActive)
  if (activeMatches.length > 1) {
    throw new Error('AMBIGUOUS_SERVICE_AREA')
  }
  if (activeMatches.length === 1) {
    return {
      serviceable: true,
      operationalZoneId: activeMatches[0]!.operationalZoneId,
      serviceAreaId: activeMatches[0]!.id,
      evaluatedAt: now.toISOString(),
    }
  }

  return {
    serviceable: false,
    reason: matches.length > 0 ? 'ZONE_SUSPENDED' : 'OUTSIDE_SERVICE_AREA',
    evaluatedAt: now.toISOString(),
  }
}

type Position = [number, number]
type LinearRing = Position[]
type Polygon = LinearRing[]

export function geoJsonContainsPoint(value: unknown, longitude: number, latitude: number): boolean {
  const polygons = parsePolygons(value)
  return polygons.some((polygon) => polygonContainsPoint(polygon, longitude, latitude))
}

function parsePolygons(value: unknown): Polygon[] {
  if (!isRecord(value) || typeof value['type'] !== 'string') return []

  if (value['type'] === 'Polygon') {
    const polygon = parsePolygon(value['coordinates'])
    return polygon ? [polygon] : []
  }

  if (value['type'] === 'MultiPolygon' && Array.isArray(value['coordinates'])) {
    const polygons: Polygon[] = []
    for (const candidate of value['coordinates']) {
      const polygon = parsePolygon(candidate)
      if (polygon) polygons.push(polygon)
    }
    return polygons
  }

  return []
}

function parsePolygon(value: unknown): Polygon | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined

  const rings: Polygon = []
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length < 4) return undefined
    const ring: LinearRing = []
    for (const point of candidate) {
      if (
        !Array.isArray(point) ||
        point.length < 2 ||
        typeof point[0] !== 'number' ||
        typeof point[1] !== 'number' ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1])
      ) {
        return undefined
      }
      ring.push([point[0], point[1]])
    }
    rings.push(ring)
  }
  return rings
}

function polygonContainsPoint(polygon: Polygon, longitude: number, latitude: number): boolean {
  const [outerRing, ...holes] = polygon
  if (!outerRing || !ringContainsPoint(outerRing, longitude, latitude)) return false
  return !holes.some((hole) => ringContainsPoint(hole, longitude, latitude))
}

function ringContainsPoint(ring: LinearRing, longitude: number, latitude: number): boolean {
  let inside = false

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index]
    const previousPoint = ring[previous]
    if (!currentPoint || !previousPoint) continue

    if (pointOnSegment(longitude, latitude, previousPoint, currentPoint)) return true

    const [currentLongitude, currentLatitude] = currentPoint
    const [previousLongitude, previousLatitude] = previousPoint
    const intersects =
      currentLatitude > latitude !== previousLatitude > latitude &&
      longitude <
        ((previousLongitude - currentLongitude) * (latitude - currentLatitude)) /
          (previousLatitude - currentLatitude) +
          currentLongitude

    if (intersects) inside = !inside
  }

  return inside
}

function pointOnSegment(
  longitude: number,
  latitude: number,
  start: Position,
  end: Position,
): boolean {
  const deltaLongitude = end[0] - start[0]
  const deltaLatitude = end[1] - start[1]
  const lengthSquared = deltaLongitude ** 2 + deltaLatitude ** 2

  if (lengthSquared <= 1e-20) {
    const pointDistanceSquared = (longitude - start[0]) ** 2 + (latitude - start[1]) ** 2
    return pointDistanceSquared <= 1e-20
  }

  const cross = (latitude - start[1]) * deltaLongitude - (longitude - start[0]) * deltaLatitude
  if (Math.abs(cross) > 1e-10) return false

  const dot = (longitude - start[0]) * deltaLongitude + (latitude - start[1]) * deltaLatitude
  return dot >= 0 && dot <= lengthSquared
}

function responseMeta(): ResponseMeta {
  return {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}

async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}

function tenantUnavailable(reply: FastifyReply) {
  return reply
    .code(404)
    .send(errorEnvelope('TENANT_NOT_FOUND', 'The requested service is unavailable.'))
}

function errorEnvelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
    meta: responseMeta(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
