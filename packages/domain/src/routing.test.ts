import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  createRoutingProviderRegistry,
  estimateRouteDistance,
  isRouteEstimateFresh,
  roundCoordinate,
  routeDistanceFrom,
  routeEstimateKey,
  ROUTE_ESTIMATE_TTL_MS,
  URBAN_DETOUR_FACTOR,
  type RouteResult,
  type RoutingProvider,
} from './routing'

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const HOME = { latitude: 36.5501, longitude: 52.6899 }

function provider(overrides: Partial<RoutingProvider> = {}): RoutingProvider {
  return {
    code: 'NESHAN',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    route: async () => ({ outcome: 'ROUTED', distanceMetres: 1_000 }),
    ...overrides,
  }
}

describe('turning an engine’s answer into a distance', () => {
  it('takes a routed distance as measured, with no source doubt attached', () => {
    const result = routeDistanceFrom(
      { outcome: 'ROUTED', distanceMetres: 2_480, durationSeconds: 420 },
      BRANCH,
      HOME,
    )

    expect(result).toEqual({
      distanceMetres: 2_480,
      durationSeconds: 420,
      source: 'ROUTED',
    })
    expect(result.reasonCode).toBeUndefined()
  })

  it('falls back rather than stopping the order when the engine is unavailable', () => {
    const result = routeDistanceFrom(
      { outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_HTTP_503' },
      BRANCH,
      HOME,
    )

    expect(result.source).toBe('ESTIMATED')
    expect(result.reasonCode).toBe('NESHAN_HTTP_503')
    expect(result.distanceMetres).toBeGreaterThan(0)
    // The duration is genuinely unknown, and guessing one would be inventing an
    // arrival time to show a customer.
    expect(result.durationSeconds).toBeNull()
  })

  it('keeps an unreachable address distinguishable from an outage', () => {
    // Both fall back, but only one of them is our fault, and an operator chasing
    // a bad address should not be reading it as a routing incident.
    expect(routeDistanceFrom({ outcome: 'UNROUTABLE' }, BRANCH, HOME).reasonCode).toBe(
      'ROUTE_UNROUTABLE',
    )
    expect(routeDistanceFrom({ outcome: 'UNAVAILABLE' }, BRANCH, HOME).reasonCode).toBe(
      'ROUTE_UNAVAILABLE',
    )
  })

  it.each([
    ['no distance at all', { outcome: 'ROUTED' } as RouteResult],
    ['a fractional distance', { outcome: 'ROUTED', distanceMetres: 12.5 } as RouteResult],
    ['a negative distance', { outcome: 'ROUTED', distanceMetres: -1 } as RouteResult],
    [
      'an unsafe integer',
      { outcome: 'ROUTED', distanceMetres: Number.MAX_SAFE_INTEGER + 2 } as RouteResult,
    ],
  ])('refuses to trust a success carrying %s', (_label, result) => {
    const distance = routeDistanceFrom(result, BRANCH, HOME)

    // A wrong distance charges somebody, so an adapter that claims success
    // without a usable number is treated as an outage rather than believed.
    expect(distance.source).toBe('ESTIMATED')
    expect(distance.reasonCode).toBe('ROUTE_DISTANCE_UNREADABLE')
  })

  it('drops an unusable duration while keeping a usable distance', () => {
    const result = routeDistanceFrom(
      { outcome: 'ROUTED', distanceMetres: 900, durationSeconds: 1.5 },
      BRANCH,
      HOME,
    )

    expect(result.distanceMetres).toBe(900)
    expect(result.durationSeconds).toBeNull()
    expect(result.source).toBe('ROUTED')
  })
})

describe('the straight-line fallback', () => {
  it('scales the straight line up, never down', () => {
    const estimate = estimateRouteDistance(BRANCH, HOME, 'ROUTE_UNAVAILABLE')
    // The straight line between these two points, which the fallback must exceed.
    const straightLine = estimateRouteDistance(BRANCH, HOME, 'X', 1).distanceMetres

    expect(estimate.distanceMetres).toBeGreaterThan(straightLine)
    expect(estimate.distanceMetres).toBe(Math.ceil(straightLine * URBAN_DETOUR_FACTOR))
  })

  it('refuses a factor that would make the road shorter than the straight line', () => {
    expect(() => estimateRouteDistance(BRANCH, HOME, 'X', 0.9)).toThrow(DomainError)
    expect(() => estimateRouteDistance(BRANCH, HOME, 'X', Number.NaN)).toThrow(DomainError)
  })

  it('is zero-distance safe, so a doorstep pickup does not become a fare', () => {
    expect(estimateRouteDistance(BRANCH, BRANCH, 'X').distanceMetres).toBe(0)
  })
})

describe('the cache key', () => {
  it('is identical for the same saved address ordered from twice', () => {
    const restrictions = { avoidTrafficZone: true, avoidOddEvenZone: false }
    const first = routeEstimateKey('branch-1', HOME, 'MOTORCYCLE', restrictions, 'NESHAN')
    const second = routeEstimateKey('branch-1', { ...HOME }, 'MOTORCYCLE', restrictions, 'NESHAN')

    expect(first).toEqual(second)
  })

  it('survives floating-point noise below the metre', () => {
    const restrictions = { avoidTrafficZone: false, avoidOddEvenZone: false }
    const noisy = { latitude: HOME.latitude + 0.000_000_9, longitude: HOME.longitude }

    expect(routeEstimateKey('branch-1', noisy, 'CAR', restrictions, 'NESHAN')).toEqual(
      routeEstimateKey('branch-1', HOME, 'CAR', restrictions, 'NESHAN'),
    )
  })

  it.each([
    ['the vehicle', { profile: 'CAR' as const }],
    ['the congestion zone', { avoidTrafficZone: true }],
    ['the odd/even scheme', { avoidOddEvenZone: true }],
    ['the engine', { providerCode: 'BALAD' }],
  ])('separates estimates that differ by %s', (_label, change) => {
    const base = {
      profile: 'MOTORCYCLE' as const,
      avoidTrafficZone: false,
      avoidOddEvenZone: false,
      providerCode: 'NESHAN',
    }
    const changed = { ...base, ...change }

    const first = routeEstimateKey(
      'branch-1',
      HOME,
      base.profile,
      { avoidTrafficZone: base.avoidTrafficZone, avoidOddEvenZone: base.avoidOddEvenZone },
      base.providerCode,
    )
    const second = routeEstimateKey(
      'branch-1',
      HOME,
      changed.profile,
      {
        avoidTrafficZone: changed.avoidTrafficZone,
        avoidOddEvenZone: changed.avoidOddEvenZone,
      },
      changed.providerCode,
    )

    expect(first).not.toEqual(second)
  })

  it('refuses to key an estimate on nothing', () => {
    expect(() =>
      routeEstimateKey(
        '',
        HOME,
        'CAR',
        { avoidTrafficZone: false, avoidOddEvenZone: false },
        'NESHAN',
      ),
    ).toThrow(DomainError)
  })

  it('rejects a coordinate that is not a number', () => {
    expect(() => roundCoordinate(Number.POSITIVE_INFINITY)).toThrow(DomainError)
  })
})

describe('estimate freshness', () => {
  const now = new Date('2026-08-26T12:00:00.000Z')

  it('keeps an estimate until its time is up, and not after', () => {
    expect(isRouteEstimateFresh(new Date(now.getTime() - 1_000), now)).toBe(true)
    expect(isRouteEstimateFresh(new Date(now.getTime() - ROUTE_ESTIMATE_TTL_MS + 1), now)).toBe(
      true,
    )
    expect(isRouteEstimateFresh(new Date(now.getTime() - ROUTE_ESTIMATE_TTL_MS), now)).toBe(false)
  })

  it('treats a future timestamp as stale rather than as endlessly fresh', () => {
    // A clock skew that pinned a fare until the clock caught up would be much
    // worse than one extra routing call.
    expect(isRouteEstimateFresh(new Date(now.getTime() + 60_000), now)).toBe(false)
  })
})

describe('the provider registry', () => {
  it('resolves a registered provider by its full identity', () => {
    const registry = createRoutingProviderRegistry([provider()])

    expect(
      registry.resolve({
        providerCode: 'NESHAN',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'PRODUCTION',
      }).code,
    ).toBe('NESHAN')
    expect(registry.identities()).toEqual([
      { providerCode: 'NESHAN', adapterVersion: '1.0.0', adapterSpiVersion: 1, testOnly: false },
    ])
  })

  it('keeps a test-only provider out of production', () => {
    const registry = createRoutingProviderRegistry([provider({ testOnly: true })])
    const request = {
      providerCode: 'NESHAN',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1 as const,
    }

    expect(registry.resolve({ ...request, environment: 'TEST' }).code).toBe('NESHAN')
    expect(() => registry.resolve({ ...request, environment: 'PRODUCTION' })).toThrow(DomainError)
  })

  it('refuses a version it does not have rather than serving a near match', () => {
    const registry = createRoutingProviderRegistry([provider()])

    expect(() =>
      registry.resolve({
        providerCode: 'NESHAN',
        adapterVersion: '2.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
      }),
    ).toThrow(DomainError)
  })

  it.each([
    ['a lowercase code', { code: 'neshan' }],
    ['a non-semver version', { adapterVersion: 'v1' }],
    ['an unsupported SPI version', { spiVersion: 2 as 1 }],
  ])('refuses to register %s', (_label, change) => {
    expect(() => createRoutingProviderRegistry([provider(change)])).toThrow(DomainError)
  })

  it('refuses two providers with the same identity', () => {
    expect(() => createRoutingProviderRegistry([provider(), provider()])).toThrow(DomainError)
  })
})
