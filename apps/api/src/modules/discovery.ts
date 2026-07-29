import type { FastifyInstance } from 'fastify'

import {
  activeCitySummarySchema,
  catalogListQuerySchema,
  serviceabilityRequestSchema,
  type ActiveCitySummary,
  type ErrorEnvelope,
  type PaginatedResponse,
  type ProductSummary,
  type ResponseMeta,
  type ServiceabilityRequest,
  type ServiceabilityResponse,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'

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

export interface CatalogRepository {
  listProducts(input: CatalogListInput): Promise<CatalogPage>
}

export interface CityRepository {
  listActiveCities(): Promise<ActiveCitySummary[]>
}

export interface ServiceAreaRecord {
  id: string
  operationalZoneId: string
  areaActive: boolean
  zoneActive: boolean
  boundaryGeoJson: unknown
}

export interface ServiceabilityRepository {
  isCityActive(cityId: string): Promise<boolean>
  listAreas(cityId: string): Promise<ServiceAreaRecord[]>
}

export interface DiscoveryDependencies {
  catalogRepository: CatalogRepository
  cityRepository: CityRepository
  serviceabilityRepository: ServiceabilityRepository
}

export function createPrismaCityRepository(prisma: PrismaClient): CityRepository {
  return {
    async listActiveCities() {
      return prisma.city.findMany({
        where: {
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
      })
    },
  }
}

export function createPrismaCatalogRepository(prisma: PrismaClient): CatalogRepository {
  return {
    async listProducts(input) {
      const now = new Date()
      const where: Prisma.BakeryProductOfferingWhereInput = {
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

      const [offerings, totalItems] = await prisma.$transaction([
        prisma.bakeryProductOffering.findMany({
          where,
          include: {
            bakeryBranch: true,
            productVariant: { include: { product: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.bakeryProductOffering.count({ where }),
      ])

      return {
        totalItems,
        items: offerings.map((offering) => ({
          id: offering.productVariant.product.id,
          variantId: offering.productVariant.id,
          sku: offering.productVariant.sku,
          nameFa: offering.productVariant.product.nameFa,
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
        })),
      }
    },
  }
}

export function createPrismaServiceabilityRepository(
  prisma: PrismaClient,
): ServiceabilityRepository {
  return {
    async isCityActive(cityId) {
      const city = await prisma.city.findUnique({
        where: { id: cityId },
        select: { isActive: true },
      })
      return city?.isActive ?? false
    },
    async listAreas(cityId) {
      const areas = await prisma.serviceArea.findMany({
        where: { operationalZone: { is: { cityId } } },
        select: {
          id: true,
          operationalZoneId: true,
          isActive: true,
          boundaryGeoJson: true,
          operationalZone: { select: { isActive: true } },
        },
        orderBy: [{ operationalZoneId: 'asc' }, { id: 'asc' }],
      })

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
    try {
      const cities = activeCitySummarySchema
        .array()
        .parse(await dependencies.cityRepository.listActiveCities())
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

    try {
      const input: CatalogListInput = {
        cityId: parsed.data.cityId,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        ...(parsed.data.operationalZoneId && {
          operationalZoneId: parsed.data.operationalZoneId,
        }),
      }
      const page = await dependencies.catalogRepository.listProducts(input)
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

    try {
      const result = await evaluateServiceability(
        parsed.data,
        dependencies.serviceabilityRepository,
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
  now = new Date(),
): Promise<ServiceabilityResponse> {
  if (!(await repository.isCityActive(input.cityId))) {
    return {
      serviceable: false,
      reason: 'OUTSIDE_CITY',
      evaluatedAt: now.toISOString(),
    }
  }

  const areas = await repository.listAreas(input.cityId)
  let suspendedMatch: ServiceAreaRecord | undefined

  for (const area of areas) {
    if (!geoJsonContainsPoint(area.boundaryGeoJson, input.longitude, input.latitude)) {
      continue
    }
    if (area.areaActive && area.zoneActive) {
      return {
        serviceable: true,
        operationalZoneId: area.operationalZoneId,
        serviceAreaId: area.id,
        evaluatedAt: now.toISOString(),
      }
    }
    suspendedMatch = area
  }

  return {
    serviceable: false,
    reason: suspendedMatch ? 'ZONE_SUSPENDED' : 'OUTSIDE_SERVICE_AREA',
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
