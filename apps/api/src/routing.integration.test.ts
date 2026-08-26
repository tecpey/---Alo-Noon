import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  createRoutingProviderRegistry,
  estimateRouteDistance,
  ROUTE_ESTIMATE_TTL_MS,
  type RouteResult,
  type RoutingCredentialResolver,
  type RoutingProvider,
} from '@alo-noon/domain'

import { createPrismaRoutingService, type RoutingService } from './modules/routing'

/**
 * The distance a delivery is priced on, over a real database.
 *
 * What matters here is not that a routing engine can be called — the adapter's
 * own tests cover that — but the order of preference around it, because each
 * step exists to protect something different. The cache protects the routing
 * bill. The fallback protects the checkout. The refusal to cache a fallback
 * protects every fare that comes after an outage.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const HOME = { latitude: 36.5501, longitude: 52.6899 }
/**
 * The scaled straight line between BRANCH and HOME. Derived rather than written
 * down, so this asserts that the service used the domain's fallback — not that
 * someone's arithmetic matched a number in a test file.
 */
const ESTIMATED_METRES = estimateRouteDistance(BRANCH, HOME, 'X').distanceMetres

afterAll(async () => prisma.$disconnect())

databaseDescribe('routing over PostgreSQL', () => {
  it('measures once and then answers from the cache', async () => {
    const world = await buildWorld('CACHE')
    const now = new Date()

    const first = await world.service.distanceFor(world.tenantId, world.query, now)
    const second = await world.service.distanceFor(world.tenantId, world.query, now)

    expect(first).toEqual({ distanceMetres: 2_480, durationSeconds: 420, source: 'ROUTED' })
    expect(second).toEqual(first)
    // The second order to a saved address must not be a second routing bill.
    expect(world.route).toHaveBeenCalledTimes(1)
    expect(await world.cachedRows()).toBe(1)
  })

  it('asks again once the measurement is older than its lifetime', async () => {
    const world = await buildWorld('TTL')
    const now = new Date()

    await world.service.distanceFor(world.tenantId, world.query, now)
    const later = new Date(now.getTime() + ROUTE_ESTIMATE_TTL_MS + 1_000)
    world.route.mockResolvedValue({ outcome: 'ROUTED', distanceMetres: 2_610 })

    const refreshed = await world.service.distanceFor(world.tenantId, world.query, later)

    expect(world.route).toHaveBeenCalledTimes(2)
    expect(refreshed.distanceMetres).toBe(2_610)
    // Re-measuring replaces the row rather than accumulating readings.
    expect(await world.cachedRows()).toBe(1)
  })

  it('keeps selling bread when the engine is down, and says the fare was estimated', async () => {
    const world = await buildWorld('OUTAGE')
    world.route.mockResolvedValue({ outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_HTTP_503' })

    const distance = await world.service.distanceFor(world.tenantId, world.query, new Date())

    expect(distance.source).toBe('ESTIMATED')
    expect(distance.reasonCode).toBe('NESHAN_HTTP_503')
    expect(distance.distanceMetres).toBe(ESTIMATED_METRES)
    // The whole point: an outage must not become a fortnight of guessed fares.
    expect(await world.cachedRows()).toBe(0)
  })

  it('prefers a stale measurement of the real road to a fresh guess about it', async () => {
    const world = await buildWorld('STALE')
    const now = new Date()
    await world.service.distanceFor(world.tenantId, world.query, now)

    world.route.mockResolvedValue({ outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_HTTP_503' })
    const later = new Date(now.getTime() + ROUTE_ESTIMATE_TTL_MS + 1_000)
    const distance = await world.service.distanceFor(world.tenantId, world.query, later)

    expect(distance).toEqual({ distanceMetres: 2_480, durationSeconds: 420, source: 'ROUTED' })
  })

  it('estimates without calling anything when the tenant has no routing engine', async () => {
    const world = await buildWorld('UNCONFIGURED', { configure: false })

    const distance = await world.service.distanceFor(world.tenantId, world.query, new Date())

    expect(distance.source).toBe('ESTIMATED')
    expect(distance.reasonCode).toBe('ROUTING_NOT_CONFIGURED')
    expect(world.route).not.toHaveBeenCalled()
  })

  it('does not use an engine that is configured but not yet proven healthy', async () => {
    const world = await buildWorld('UNHEALTHY', { healthStatus: 'UNKNOWN' })

    const distance = await world.service.distanceFor(world.tenantId, world.query, new Date())

    // Same rule the payment gateways follow: nothing is used until an operator
    // has confirmed it works.
    expect(distance.source).toBe('ESTIMATED')
    expect(world.route).not.toHaveBeenCalled()
  })

  it('estimates rather than failing when the credential cannot be resolved', async () => {
    const world = await buildWorld('NOKEY', { credential: false })

    const distance = await world.service.distanceFor(world.tenantId, world.query, new Date())

    expect(distance.reasonCode).toBe('ROUTING_CREDENTIAL_UNAVAILABLE')
    expect(world.route).not.toHaveBeenCalled()
  })

  it('survives an adapter that throws instead of answering', async () => {
    const world = await buildWorld('THROWS')
    world.route.mockRejectedValue(new Error('boom'))

    const distance = await world.service.distanceFor(world.tenantId, world.query, new Date())

    expect(distance.source).toBe('ESTIMATED')
    expect(distance.reasonCode).toBe('ROUTING_PROVIDER_THREW')
  })

  it('keeps separate measurements for a motorcycle and a car', async () => {
    const world = await buildWorld('PROFILE')
    const now = new Date()

    await world.service.distanceFor(world.tenantId, world.query, now)
    world.route.mockResolvedValue({ outcome: 'ROUTED', distanceMetres: 3_100 })
    const byCar = await world.service.distanceFor(
      world.tenantId,
      { ...world.query, profile: 'CAR' },
      now,
    )

    // A car cannot take the alleys a motorcycle does, so serving it the
    // motorcycle's distance would undercharge every car delivery.
    expect(byCar.distanceMetres).toBe(3_100)
    expect(await world.cachedRows()).toBe(2)
  })

  it('reuses one measurement for two addresses inside the same eleven metres', async () => {
    const world = await buildWorld('ROUNDING')
    const now = new Date()

    await world.service.distanceFor(world.tenantId, world.query, now)
    const nudged = {
      ...world.query,
      destination: { latitude: HOME.latitude + 0.000_02, longitude: HOME.longitude },
    }
    const second = await world.service.distanceFor(world.tenantId, nudged, now)

    expect(second.source).toBe('ROUTED')
    expect(world.route).toHaveBeenCalledTimes(1)
  })

  it('never serves one tenant’s measurement to another', async () => {
    const first = await buildWorld('TENANT1')
    const second = await buildWorld('TENANT2')
    const now = new Date()

    await first.service.distanceFor(first.tenantId, first.query, now)
    second.route.mockResolvedValue({ outcome: 'ROUTED', distanceMetres: 9_999 })
    const other = await second.service.distanceFor(second.tenantId, second.query, now)

    expect(other.distanceMetres).toBe(9_999)
    expect(second.route).toHaveBeenCalledTimes(1)
  })
})

interface World {
  tenantId: string
  query: { branchId: string; origin: typeof BRANCH; destination: typeof HOME }
  service: RoutingService
  route: ReturnType<typeof vi.fn>
  cachedRows(): Promise<number>
}

async function buildWorld(
  label: string,
  options: {
    configure?: boolean
    credential?: boolean
    healthStatus?: 'UNKNOWN' | 'HEALTHY'
  } = {},
): Promise<World> {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const now = new Date()

  const tenant = await prisma.tenant.create({
    data: { slug: `rt-${suffix.toLowerCase()}`, name: `Routing ${suffix}` },
  })
  const tenantId = tenant.id
  const city = await prisma.city.create({
    data: { tenantId, code: `RC${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `RZ${suffix}`.slice(0, 16),
      nameFa: 'ناحیه',
      isActive: true,
    },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Bakery ${suffix}`,
      displayNameFa: 'نانوایی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `RB${suffix}`.slice(0, 16),
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: String(BRANCH.latitude),
      longitude: String(BRANCH.longitude),
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })

  if (options.configure !== false) {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      await transaction.routingProviderConfiguration.create({
        data: {
          tenantId,
          providerCode: 'NESHAN',
          adapterVersion: '1.0.0',
          adapterSpiVersion: 1,
          environment: 'TEST',
          credentialReference: 'env://ROUTING_NESHAN_KEY',
          enabled: true,
          isDefault: true,
          healthStatus: options.healthStatus ?? 'HEALTHY',
          updatedAt: now,
        },
      })
    })
  }

  const route = vi.fn<(...args: never[]) => Promise<RouteResult>>().mockResolvedValue({
    outcome: 'ROUTED',
    distanceMetres: 2_480,
    durationSeconds: 420,
  })
  const provider: RoutingProvider = {
    code: 'NESHAN',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    route: route as unknown as RoutingProvider['route'],
  }

  const credentialResolver: RoutingCredentialResolver = {
    testOnly: true,
    async resolve() {
      if (options.credential === false) throw new Error('no key')
      const material = new TextEncoder().encode('service.test-key')
      return { material, dispose: () => material.fill(0) }
    },
  }

  return {
    tenantId,
    query: { branchId: branch.id, origin: BRANCH, destination: HOME },
    route,
    service: createPrismaRoutingService(prisma, {
      registry: createRoutingProviderRegistry([provider]),
      credentialResolver,
      environment: 'TEST',
    }),
    async cachedRows() {
      return prisma.routeEstimate.count({ where: { tenantId } })
    },
  }
}
