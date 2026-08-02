import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ActiveCitySummary, ProductSummary } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import {
  evaluateServiceability,
  geoJsonContainsPoint,
  type CatalogListInput,
  type CatalogRepository,
  type CityRepository,
  type ServiceabilityRepository,
} from './modules/discovery'

const cityId = '11111111-1111-4111-8111-111111111111'
const zoneId = '22222222-2222-4222-8222-222222222222'
const areaId = '33333333-3333-4333-8333-333333333333'
const productId = '44444444-4444-4444-8444-444444444444'
const variantId = '55555555-5555-4555-8555-555555555555'
const branchId = '66666666-6666-4666-8666-666666666666'
const tenantId = '00000000-0000-4000-8000-000000000001'
const discoveryAuth: AuthDependencies = {
  repository: { resolveTenantByHost: async () => tenantId } as unknown as AuthRepository,
  deliveryProvider: { send: async () => undefined },
  otpPepper: 'discovery-otp-pepper-that-is-long-enough',
  sessionPepper: 'discovery-session-pepper-that-is-long-enough',
  secureCookie: false,
}

const city: ActiveCitySummary = {
  id: cityId,
  code: 'BABOL',
  nameFa: 'بابل',
  timezone: 'Asia/Tehran',
}

const product: ProductSummary = {
  id: productId,
  offeringId: '77777777-7777-4777-8777-777777777777',
  variantId,
  sku: 'ALO-SIGNATURE-001',
  nameFa: 'بربری امضادار',
  fulfillmentClass: 'SIGNATURE_FRESH',
  freshnessClaim: 'FRESHLY_PRODUCED',
  price: { amount: '250000', currency: 'IRR' },
  bakeryBranchId: branchId,
  lifecycle: 'ACTIVE',
}

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [52.6, 36.5],
      [52.8, 36.5],
      [52.8, 36.7],
      [52.6, 36.7],
      [52.6, 36.5],
    ],
  ],
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
})

describe('active city discovery API', () => {
  it('returns only repository-approved active service cities', async () => {
    const repository: CityRepository = {
      listActiveCities: async () => [city],
    }
    const app = await buildApp({ auth: discoveryAuth, cityRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/serviceability/cities',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      data: [{ id: cityId, code: 'BABOL', nameFa: 'بابل' }],
    })
  })

  it('returns a safe error when city persistence is unavailable', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      cityRepository: {
        listActiveCities: async () => {
          throw new Error('postgresql://secret@database/internal')
        },
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/serviceability/cities',
    })

    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('postgresql')
    expect(response.json()).toMatchObject({
      error: { code: 'CITY_DISCOVERY_UNAVAILABLE' },
    })
  })

  it('rejects repository output that violates the public city contract', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      cityRepository: {
        listActiveCities: async () => [{ ...city, timezone: '' }],
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/serviceability/cities',
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'CITY_DISCOVERY_UNAVAILABLE' },
    })
  })

  it('fails closed before tenant-owned discovery when the host has no tenant', async () => {
    const listActiveCities = vi.fn<CityRepository['listActiveCities']>()
    const auth = {
      ...discoveryAuth,
      repository: { resolveTenantByHost: async () => null } as unknown as AuthRepository,
    }
    const app = await buildApp({ auth, cityRepository: { listActiveCities } })
    apps.push(app)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/serviceability/cities',
      headers: { host: 'unknown.example', 'x-tenant-id': tenantId },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'TENANT_NOT_FOUND' } })
    expect(listActiveCities).not.toHaveBeenCalled()
  })
})

describe('catalog discovery API', () => {
  it('validates filters and returns a paginated contract-safe catalog', async () => {
    const calls: CatalogListInput[] = []
    const repository: CatalogRepository = {
      listProducts: async (_tenantId, input) => {
        calls.push(input)
        return { items: [product], totalItems: 1 }
      },
    }
    const app = await buildApp({ auth: discoveryAuth, catalogRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?cityId=${cityId}&page=1&pageSize=10`,
    })

    expect(response.statusCode).toBe(200)
    expect(calls).toEqual([{ cityId, page: 1, pageSize: 10 }])
    expect(response.json()).toMatchObject({
      success: true,
      data: [{ sku: 'ALO-SIGNATURE-001', price: { amount: '250000', currency: 'IRR' } }],
      meta: { pagination: { totalItems: 1, totalPages: 1 } },
    })
  })

  it('rejects an invalid city identifier before repository access', async () => {
    const listProducts = vi.fn<CatalogRepository['listProducts']>()
    const app = await buildApp({ auth: discoveryAuth, catalogRepository: { listProducts } })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?cityId=babol',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_CATALOG_QUERY' },
    })
    expect(listProducts).not.toHaveBeenCalled()
  })

  it('returns a safe dependency error without leaking internals', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: {
        listProducts: async () => {
          throw new Error('postgresql://secret@database/internal')
        },
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?cityId=${cityId}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('postgresql')
    expect(response.json()).toMatchObject({
      error: { code: 'CATALOG_UNAVAILABLE' },
    })
  })
})

describe('serviceability API', () => {
  it('returns the matching active zone and service area', async () => {
    const repository: ServiceabilityRepository = {
      isCityActive: async () => true,
      listAreas: async () => [
        {
          id: areaId,
          operationalZoneId: zoneId,
          areaActive: true,
          zoneActive: true,
          boundaryGeoJson: square,
        },
      ],
    }
    const app = await buildApp({ auth: discoveryAuth, serviceabilityRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/serviceability/check',
      payload: { cityId, latitude: 36.6, longitude: 52.7 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        serviceable: true,
        operationalZoneId: zoneId,
        serviceAreaId: areaId,
      },
    })
  })

  it('distinguishes a suspended matching zone from an outside address', async () => {
    const repository: ServiceabilityRepository = {
      isCityActive: async () => true,
      listAreas: async () => [
        {
          id: areaId,
          operationalZoneId: zoneId,
          areaActive: true,
          zoneActive: false,
          boundaryGeoJson: square,
        },
      ],
    }

    const result = await evaluateServiceability(
      { cityId, latitude: 36.6, longitude: 52.7 },
      repository,
      tenantId,
      new Date('2026-07-29T12:00:00.000Z'),
    )

    expect(result).toEqual({
      serviceable: false,
      reason: 'ZONE_SUSPENDED',
      evaluatedAt: '2026-07-29T12:00:00.000Z',
    })
  })

  it('fails closed when active service polygons overlap', async () => {
    const repository: ServiceabilityRepository = {
      isCityActive: async () => true,
      listAreas: async () => [
        {
          id: areaId,
          operationalZoneId: zoneId,
          areaActive: true,
          zoneActive: true,
          boundaryGeoJson: square,
        },
        {
          id: productId,
          operationalZoneId: branchId,
          areaActive: true,
          zoneActive: true,
          boundaryGeoJson: square,
        },
      ],
    }
    await expect(
      evaluateServiceability({ cityId, latitude: 36.6, longitude: 52.7 }, repository, tenantId),
    ).rejects.toThrow('AMBIGUOUS_SERVICE_AREA')
  })

  it('rejects malformed coordinates', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/serviceability/check',
      payload: { cityId, latitude: 120, longitude: 52.7 },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_SERVICEABILITY_REQUEST' },
    })
  })
})

describe('GeoJSON evaluation', () => {
  it('supports Polygon boundaries and includes their exterior edge', () => {
    expect(geoJsonContainsPoint(square, 52.7, 36.6)).toBe(true)
    expect(geoJsonContainsPoint(square, 52.6, 36.6)).toBe(true)
    expect(geoJsonContainsPoint(square, 53, 36.6)).toBe(false)
  })

  it('supports MultiPolygon geometry and excludes polygon holes', () => {
    const multiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        square.coordinates,
        [
          [
            [53, 36.5],
            [53.2, 36.5],
            [53.2, 36.7],
            [53, 36.7],
            [53, 36.5],
          ],
        ],
      ],
    }
    const polygonWithHole = {
      type: 'Polygon',
      coordinates: [
        square.coordinates[0],
        [
          [52.65, 36.55],
          [52.75, 36.55],
          [52.75, 36.65],
          [52.65, 36.65],
          [52.65, 36.55],
        ],
      ],
    }

    expect(geoJsonContainsPoint(multiPolygon, 53.1, 36.6)).toBe(true)
    expect(geoJsonContainsPoint(polygonWithHole, 52.7, 36.6)).toBe(false)
    expect(geoJsonContainsPoint(polygonWithHole, 52.62, 36.52)).toBe(true)
  })

  it('rejects unsupported or malformed geometry', () => {
    expect(geoJsonContainsPoint({ type: 'Point', coordinates: [52.7, 36.6] }, 52.7, 36.6)).toBe(
      false,
    )
    expect(geoJsonContainsPoint({ type: 'Polygon', coordinates: [[]] }, 52.7, 36.6)).toBe(false)
  })
})
