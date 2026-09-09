import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ActiveCitySummary, ProductDetail, ProductSummary } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import {
  evaluateServiceability,
  geoJsonContainsPoint,
  type CatalogDetailInput,
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
  deliveryService: { request: async () => Promise.reject(new Error('unused')) },
  otpPepper: 'discovery-otp-pepper-that-is-long-enough',
  abusePepper: 'discovery-abuse-pepper-that-is-long-enough',
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
  slug: 'barbari-emzadar',
  nameFa: 'بربری امضادار',
  categoryCode: 'BARBARI',
  categoryNameFa: 'بربری',
  fulfillmentClass: 'SIGNATURE_FRESH',
  freshnessClaim: 'FRESHLY_PRODUCED',
  price: { amount: '250000', currency: 'IRR' },
  bakeryBranchId: branchId,
  operationalZoneId: zoneId,
  lifecycle: 'ACTIVE',
}

const productDetail: ProductDetail = {
  ...product,
  descriptionFa: 'بربری تازه با رویهٔ کنجدی.',
  ingredients: ['آرد گندم', 'کنجد', 'مخمر', 'نمک'],
  allergens: ['گلوتن', 'کنجد'],
  dietaryAttributes: [],
  freshnessWindowMinutes: 90,
}

/**
 * A repository method this test has asserted must not run.
 *
 * Failing loudly beats returning null: a route that reached for the wrong half
 * of the repository would otherwise pass as a clean 404.
 */
const notCalled = (): never => {
  throw new Error('This repository method should not have been called')
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
      findProduct: notCalled,
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
      data: [
        {
          sku: 'ALO-SIGNATURE-001',
          // The storefront addresses a bread by slug and groups it by category,
          // so both have to survive the trip out of the repository.
          slug: 'barbari-emzadar',
          categoryCode: 'BARBARI',
          categoryNameFa: 'بربری',
          price: { amount: '250000', currency: 'IRR' },
        },
      ],
      meta: { pagination: { totalItems: 1, totalPages: 1 } },
    })
  })

  it('rejects an invalid city identifier before repository access', async () => {
    const listProducts = vi.fn<CatalogRepository['listProducts']>()
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: { listProducts, findProduct: notCalled },
    })
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
        findProduct: notCalled,
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

describe('single product API', () => {
  it('returns the full product for a slug on sale in this city', async () => {
    const calls: CatalogDetailInput[] = []
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: {
        listProducts: notCalled,
        findProduct: async (_tenantId, input) => {
          calls.push(input)
          return productDetail
        },
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/barbari-emzadar?cityId=${cityId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(calls).toEqual([{ slug: 'barbari-emzadar', cityId }])
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        slug: 'barbari-emzadar',
        allergens: ['گلوتن', 'کنجد'],
        price: { amount: '250000', currency: 'IRR' },
      },
    })
  })

  it('narrows to a zone when one is given', async () => {
    const calls: CatalogDetailInput[] = []
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: {
        listProducts: notCalled,
        findProduct: async (_tenantId, input) => {
          calls.push(input)
          return productDetail
        },
      },
    })
    apps.push(app)

    await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/barbari-emzadar?cityId=${cityId}&operationalZoneId=${zoneId}`,
    })

    expect(calls).toEqual([{ slug: 'barbari-emzadar', cityId, operationalZoneId: zoneId }])
  })

  /**
   * A slug nobody sells here is a 404, not an empty success. The customer
   * followed a link to a bread; "we do not have this" is the answer, whether
   * because it was never ours or because this city's bakeries do not make it.
   */
  it('answers 404 for a slug that is not on sale here', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: { listProducts: notCalled, findProduct: async () => null },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/nan-e-khiali?cityId=${cityId}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } })
  })

  it('rejects a missing city before reaching the repository', async () => {
    const findProduct = vi.fn<CatalogRepository['findProduct']>()
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: { listProducts: notCalled, findProduct },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/barbari-emzadar',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CATALOG_QUERY' } })
    expect(findProduct).not.toHaveBeenCalled()
  })

  it('refuses to publish a product the public contract does not describe', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: {
        listProducts: notCalled,
        // A repository that grew an internal field must not leak it, and one
        // that lost a required field must not serve half a product.
        findProduct: async () =>
          ({ ...productDetail, price: { amount: '', currency: 'IRR' } }) as ProductDetail,
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/barbari-emzadar?cityId=${cityId}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'CATALOG_UNAVAILABLE' } })
  })

  it('does not leak internals when the read fails', async () => {
    const app = await buildApp({
      auth: discoveryAuth,
      catalogRepository: {
        listProducts: notCalled,
        findProduct: async () => {
          throw new Error('postgresql://secret@database/internal')
        },
      },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/barbari-emzadar?cityId=${cityId}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('postgresql')
  })

  it('fails closed when the host resolves to no tenant', async () => {
    const findProduct = vi.fn<CatalogRepository['findProduct']>()
    const app = await buildApp({
      auth: {
        ...discoveryAuth,
        repository: { resolveTenantByHost: async () => null } as unknown as AuthRepository,
      },
      catalogRepository: { listProducts: notCalled, findProduct },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/barbari-emzadar?cityId=${cityId}`,
      headers: { host: 'unknown.example', 'x-tenant-id': tenantId },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'TENANT_NOT_FOUND' } })
    expect(findProduct).not.toHaveBeenCalled()
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
