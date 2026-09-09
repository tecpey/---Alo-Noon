import { DomainError } from './errors'
import { calculateDeliveryDistanceMeters, type DeliveryCoordinates } from './delivery-pricing'

/**
 * How far it actually is by road, and what to do when nobody can say.
 *
 * Delivery has been priced on straight-line distance since the beginning, which
 * is wrong in a specific and expensive direction: a river, a motorway with no
 * crossing, or a one-way system can put two points 800 metres apart and twenty
 * minutes of riding. The bakery absorbs that difference on every order.
 *
 * A routing engine fixes it, and introduces a dependency that will sometimes be
 * down. Three rules follow from that, and they are the whole design:
 *
 * **A routing outage must not stop an order.** Bread is time-critical and the
 * customer is standing at a checkout. When routing is unavailable the straight
 * line is scaled by a documented factor and the order proceeds.
 *
 * **Every distance says where it came from.** A fare a customer disputes has to
 * be explainable, and "we could not reach the routing service so we estimated"
 * is an answer. A number nobody can account for is not.
 *
 * **Estimates are never cached.** Routed distances are worth keeping — the same
 * branch delivers to the same streets all week — but caching a fallback would
 * freeze it in place long after routing recovered, quietly turning a minutes-long
 * outage into a fortnight of guessed fares.
 */
export const ROUTING_ADAPTER_SPI_VERSION = 1 as const
export type RoutingAdapterSpiVersion = typeof ROUTING_ADAPTER_SPI_VERSION

export type RoutingEnvironment = 'TEST' | 'PRODUCTION'

/**
 * What the courier is riding. It changes the road network available: a
 * motorcycle takes alleys and contraflow that a car cannot, and the two are
 * routinely twenty per cent apart in a Persian city centre.
 */
export const ROUTING_PROFILES = ['MOTORCYCLE', 'CAR'] as const
export type RoutingProfile = (typeof ROUTING_PROFILES)[number]

/** Whether a distance was measured on the road network or inferred from it. */
export type RouteDistanceSource = 'ROUTED' | 'ESTIMATED'

/**
 * Restrictions that decide whether a courier may legally enter the city centre
 * at all. Iranian cities run a congestion zone (طرح ترافیک) and an odd/even
 * plate scheme, and a route through a zone the rider cannot enter is not a
 * shorter route — it is a fine. They belong on the request rather than in
 * provider configuration because they vary per courier and per day.
 */
export interface RoutingRestrictions {
  readonly avoidTrafficZone: boolean
  readonly avoidOddEvenZone: boolean
}

export interface RoutingProviderConfigurationView {
  readonly id: string
  readonly tenantId: string
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: RoutingAdapterSpiVersion
  readonly environment: RoutingEnvironment
  readonly credentialReference: string
}

export interface ResolvedRoutingCredential {
  readonly material: Uint8Array
  dispose(): void
}

export interface RoutingCredentialResolver {
  readonly testOnly?: boolean
  resolve(
    reference: string,
    tenantId: string,
    providerCode: string,
  ): Promise<ResolvedRoutingCredential>
}

export interface RouteRequest {
  readonly origin: DeliveryCoordinates
  readonly destination: DeliveryCoordinates
  /**
   * Stops between origin and destination, in the order they are to be visited.
   * Present in the contract from the start because multi-drop batching is the
   * largest cost lever in the plan, and an SPI that only knows about one drop
   * would have to be revised to reach it.
   */
  readonly waypoints?: readonly DeliveryCoordinates[]
  readonly profile: RoutingProfile
  readonly restrictions: RoutingRestrictions
  readonly timeoutMs: number
  readonly configuration: RoutingProviderConfigurationView
  readonly credential: ResolvedRoutingCredential
}

export type RouteOutcome =
  /** The engine answered with a usable distance. */
  | 'ROUTED'
  /** No verdict: unreachable, timed out, rate limited, or an unreadable reply. */
  | 'UNAVAILABLE'
  /** The engine answered definitively that no route exists between these points. */
  | 'UNROUTABLE'

export interface RouteLeg {
  readonly distanceMetres: number
  readonly durationSeconds: number | null
}

export interface RouteResult {
  readonly outcome: RouteOutcome
  readonly distanceMetres?: number
  readonly durationSeconds?: number
  readonly legs?: readonly RouteLeg[]
  /** Stable, non-secret code recorded against the estimate. */
  readonly reasonCode?: string
}

export interface RoutingProvider {
  readonly code: string
  readonly adapterVersion: string
  readonly spiVersion: RoutingAdapterSpiVersion
  readonly testOnly?: boolean
  route(request: RouteRequest): Promise<RouteResult>
}

export interface RoutingProviderRegistry {
  resolve(request: {
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: RoutingAdapterSpiVersion
    environment: RoutingEnvironment
  }): RoutingProvider
  identities(): readonly Readonly<{
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: RoutingAdapterSpiVersion
    testOnly: boolean
  }>[]
}

/**
 * How much longer the road is than the straight line, when no engine can say.
 *
 * 1.3 is the low end of the range circuity studies report for dense urban street
 * grids, and the low end is chosen deliberately: this factor sets a delivery fee,
 * so overshooting overcharges every customer on every order during an outage,
 * while undershooting costs the bakery a little on a few. The asymmetry is not
 * in the arithmetic, it is in who pays for being wrong.
 *
 * It is a stated assumption, not a measurement. Once routed distances accumulate
 * in the estimate cache, the ratio between them and the straight lines they
 * replaced is directly measurable, and this constant should be replaced by that
 * number per city.
 */
export const URBAN_DETOUR_FACTOR = 1.3

/**
 * How long a routed distance stays usable.
 *
 * Roads do change — a new bridge, a street turned one-way, a widened congestion
 * zone — but on the scale of seasons, not days. Two weeks keeps the cache
 * earning while bounding how stale any one fare can be, and re-routing a
 * still-busy address costs one call a fortnight.
 */
export const ROUTE_ESTIMATE_TTL_MS = 14 * 24 * 60 * 60 * 1_000

/**
 * Decimal places kept in a cache key's coordinates.
 *
 * Four places is about eleven metres. The point is not to cluster neighbours
 * together — it is that a saved address reused across orders produces a byte
 * identical key, while floating-point noise in the last digits does not miss.
 * Coarser rounding would buy a few more hits between different customers at the
 * cost of charging them for a distance that is not theirs.
 */
export const ROUTE_ESTIMATE_COORDINATE_PRECISION = 4

export interface RouteEstimateKey {
  readonly branchId: string
  readonly latitude: number
  readonly longitude: number
  readonly profile: RoutingProfile
  readonly avoidTrafficZone: boolean
  readonly avoidOddEvenZone: boolean
  /**
   * Two engines disagree about the same road, so a cached distance belongs to
   * the engine that produced it. Switching providers therefore misses rather
   * than serving another engine's numbers.
   */
  readonly providerCode: string
}

export function routeEstimateKey(
  branchId: string,
  destination: DeliveryCoordinates,
  profile: RoutingProfile,
  restrictions: RoutingRestrictions,
  providerCode: string,
): Readonly<RouteEstimateKey> {
  if (!branchId) {
    throw new DomainError('INVALID_ROUTE_REQUEST', 'A route estimate needs a branch')
  }
  return Object.freeze({
    branchId,
    latitude: roundCoordinate(destination.latitude),
    longitude: roundCoordinate(destination.longitude),
    profile,
    avoidTrafficZone: restrictions.avoidTrafficZone,
    avoidOddEvenZone: restrictions.avoidOddEvenZone,
    providerCode,
  })
}

export function roundCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new DomainError('INVALID_DELIVERY_COORDINATES', 'Coordinate is not a finite number')
  }
  const scale = 10 ** ROUTE_ESTIMATE_COORDINATE_PRECISION
  return Math.round(value * scale) / scale
}

export function isRouteEstimateFresh(
  computedAt: Date,
  now: Date,
  ttlMs: number = ROUTE_ESTIMATE_TTL_MS,
): boolean {
  const age = now.getTime() - computedAt.getTime()
  // A future timestamp is a clock problem, not a fresh estimate. Treating it as
  // stale re-routes once rather than pinning a fare until the clock catches up.
  return age >= 0 && age < ttlMs
}

export interface RouteDistance {
  readonly distanceMetres: number
  readonly durationSeconds: number | null
  readonly source: RouteDistanceSource
  /**
   * Why this distance is an estimate rather than a measurement. Absent when the
   * distance was routed, so its presence alone answers "what went wrong?".
   */
  readonly reasonCode?: string
}

/**
 * The fallback, applied when no engine could answer.
 *
 * Kept separate from the service that calls the engine so the arithmetic can be
 * read, tested, and argued about without a gateway, a database, or a clock.
 */
export function estimateRouteDistance(
  origin: DeliveryCoordinates,
  destination: DeliveryCoordinates,
  reasonCode: string,
  detourFactor: number = URBAN_DETOUR_FACTOR,
): Readonly<RouteDistance> {
  if (!Number.isFinite(detourFactor) || detourFactor < 1) {
    throw new DomainError(
      'INVALID_ROUTE_REQUEST',
      'The detour factor must be at least 1: a road is never shorter than the straight line',
    )
  }
  const straightLine = calculateDeliveryDistanceMeters(origin, destination)
  return Object.freeze({
    distanceMetres: Math.ceil(straightLine * detourFactor),
    durationSeconds: null,
    source: 'ESTIMATED' as const,
    reasonCode,
  })
}

/**
 * Turns an engine's answer into a distance, or says why it could not.
 *
 * Both non-routed outcomes fall back, but they are not the same event and the
 * reason code keeps them apart: `UNAVAILABLE` is our problem — a key, a quota,
 * a network — and should page someone if it persists, while `UNROUTABLE` means
 * the address genuinely cannot be reached by road, which is an address problem
 * and belongs in front of an operator.
 */
export function routeDistanceFrom(
  result: RouteResult,
  origin: DeliveryCoordinates,
  destination: DeliveryCoordinates,
  detourFactor: number = URBAN_DETOUR_FACTOR,
): Readonly<RouteDistance> {
  if (
    result.outcome === 'ROUTED' &&
    result.distanceMetres !== undefined &&
    Number.isSafeInteger(result.distanceMetres) &&
    result.distanceMetres >= 0
  ) {
    return Object.freeze({
      distanceMetres: result.distanceMetres,
      durationSeconds:
        result.durationSeconds !== undefined && Number.isSafeInteger(result.durationSeconds)
          ? result.durationSeconds
          : null,
      source: 'ROUTED' as const,
    })
  }
  // A ROUTED outcome carrying an unusable distance is an adapter bug, and it is
  // treated as an outage rather than trusted: a wrong distance charges someone.
  const reasonCode =
    result.outcome === 'ROUTED'
      ? 'ROUTE_DISTANCE_UNREADABLE'
      : (result.reasonCode ?? `ROUTE_${result.outcome}`)
  return estimateRouteDistance(origin, destination, reasonCode, detourFactor)
}

export function createRoutingProviderRegistry(
  providers: readonly RoutingProvider[],
): RoutingProviderRegistry {
  const registered = new Map<string, RoutingProvider>()
  const identities: Array<ReturnType<RoutingProviderRegistry['identities']>[number]> = []
  for (const provider of providers) {
    if (
      !/^[A-Z][A-Z0-9_]{1,31}$/.test(provider.code) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(provider.adapterVersion) ||
      provider.spiVersion !== ROUTING_ADAPTER_SPI_VERSION
    ) {
      throw new DomainError('ROUTING_REGISTRY_INVALID', 'Routing provider identity is invalid')
    }
    const key = registryKey(provider.code, provider.adapterVersion, provider.spiVersion)
    if (registered.has(key)) {
      throw new DomainError('ROUTING_REGISTRY_INVALID', 'Routing provider identity is duplicated')
    }
    registered.set(key, provider)
    identities.push(
      Object.freeze({
        providerCode: provider.code,
        adapterVersion: provider.adapterVersion,
        adapterSpiVersion: provider.spiVersion,
        testOnly: provider.testOnly === true,
      }),
    )
  }
  const snapshot = Object.freeze(identities)
  return Object.freeze({
    resolve(request: {
      providerCode: string
      adapterVersion: string
      adapterSpiVersion: RoutingAdapterSpiVersion
      environment: RoutingEnvironment
    }) {
      const provider = registered.get(
        registryKey(request.providerCode, request.adapterVersion, request.adapterSpiVersion),
      )
      if (!provider || (request.environment === 'PRODUCTION' && provider.testOnly === true)) {
        throw new DomainError('ROUTING_PROVIDER_UNAVAILABLE', 'Routing provider is unavailable')
      }
      return provider
    },
    identities: () => snapshot,
  })
}

function registryKey(code: string, adapterVersion: string, spiVersion: number): string {
  return `${code}@${adapterVersion}#${spiVersion}`
}
