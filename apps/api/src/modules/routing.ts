import type { Prisma, PrismaClient } from '@alo-noon/database'
import {
  isRouteEstimateFresh,
  ROUTE_ESTIMATE_TTL_MS,
  roundCoordinate,
  routeDistanceFrom,
  estimateRouteDistance,
  type DeliveryCoordinates,
  type RouteDistance,
  type RoutingAdapterSpiVersion,
  type RoutingCredentialResolver,
  type RoutingProfile,
  type RoutingProvider,
  type RoutingProviderRegistry,
  type RoutingRestrictions,
} from '@alo-noon/domain'

/**
 * How far it is from the branch to the door, answered as cheaply as honestly
 * possible.
 *
 * Three sources, in order, and the order is the whole design:
 *
 * 1. **A cached measurement**, if one is fresh. A bakery delivers from the same
 *    branch to the same streets all week; asking the engine again is spending
 *    money to be told what we already know.
 * 2. **The engine**, if one is configured, enabled, healthy and default.
 * 3. **The straight line, scaled**, if neither of those produced an answer.
 *
 * Step three is what makes this safe to depend on. A routing outage during the
 * evening rush must not stop a customer checking out — bread is time-critical
 * and they are standing at a payment screen — so the fallback is a first-class
 * path, not an error handler. What it must never do is hide: every answer
 * carries its source, and a fare priced on an estimate can be explained as one.
 *
 * Nothing here writes an estimate row for a fallback. Caching one would freeze a
 * ten-minute outage into a fortnight of guessed fares.
 */
export interface RouteQuery {
  branchId: string
  origin: DeliveryCoordinates
  destination: DeliveryCoordinates
  profile?: RoutingProfile
  restrictions?: RoutingRestrictions
}

export interface RoutingService {
  /**
   * Never throws for a routing problem. A caller pricing an order needs a
   * distance, and the absence of one is expressed as an ESTIMATED source with a
   * reason code rather than as an exception it would have to catch and guess at.
   */
  distanceFor(tenantId: string, query: RouteQuery, now: Date): Promise<Readonly<RouteDistance>>
}

export interface PrismaRoutingOptions {
  registry: RoutingProviderRegistry
  credentialResolver: RoutingCredentialResolver
  environment: 'TEST' | 'PRODUCTION'
  invocationTimeoutMs?: number
  ttlMs?: number
  /** Defaults for a tenant that has not been asked what its couriers ride. */
  defaultProfile?: RoutingProfile
  defaultRestrictions?: RoutingRestrictions
}

const DEFAULT_TIMEOUT_MS = 4_000
const DEFAULT_PROFILE: RoutingProfile = 'MOTORCYCLE'
/**
 * Assumed rather than configured, until a tenant says otherwise: a courier on a
 * motorcycle in an Iranian city is normally subject to neither scheme, and
 * assuming a restriction that does not apply would route deliveries the long way
 * round every day for no reason.
 */
const DEFAULT_RESTRICTIONS: RoutingRestrictions = Object.freeze({
  avoidTrafficZone: false,
  avoidOddEvenZone: false,
})

export function createPrismaRoutingService(
  prisma: PrismaClient,
  options: PrismaRoutingOptions,
): RoutingService {
  const timeoutMs = options.invocationTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const ttlMs = options.ttlMs ?? ROUTE_ESTIMATE_TTL_MS
  const defaultProfile = options.defaultProfile ?? DEFAULT_PROFILE
  const defaultRestrictions = options.defaultRestrictions ?? DEFAULT_RESTRICTIONS

  return {
    async distanceFor(tenantId, query, now) {
      const profile = query.profile ?? defaultProfile
      const restrictions = query.restrictions ?? defaultRestrictions
      const fallback = (reasonCode: string) =>
        estimateRouteDistance(query.origin, query.destination, reasonCode)

      const configuration = await loadConfiguration(prisma, tenantId, options.environment)
      if (!configuration) {
        // Not an error: a tenant that has not bought routing yet still sells
        // bread, and this is the state every tenant starts in.
        return fallback('ROUTING_NOT_CONFIGURED')
      }

      const latitude = roundCoordinate(query.destination.latitude)
      const longitude = roundCoordinate(query.destination.longitude)
      const where = {
        tenantId,
        bakeryBranchId: query.branchId,
        destinationLatitude: latitude,
        destinationLongitude: longitude,
        profile,
        avoidTrafficZone: restrictions.avoidTrafficZone,
        avoidOddEvenZone: restrictions.avoidOddEvenZone,
        providerCode: configuration.providerCode,
      }

      const cached = await withTenantRead(prisma, tenantId, (transaction) =>
        transaction.routeEstimate.findFirst({ where }),
      )
      if (cached && isRouteEstimateFresh(cached.computedAt, now, ttlMs)) {
        return Object.freeze({
          distanceMetres: cached.distanceMetres,
          durationSeconds: cached.durationSeconds,
          source: 'ROUTED' as const,
        })
      }

      let provider: RoutingProvider
      try {
        provider = options.registry.resolve({
          providerCode: configuration.providerCode,
          adapterVersion: configuration.adapterVersion,
          adapterSpiVersion: configuration.adapterSpiVersion as RoutingAdapterSpiVersion,
          environment: options.environment,
        })
      } catch {
        // A configuration naming an adapter this deployment does not carry. The
        // stale cached row above is preferred to nothing, but only if it exists.
        return staleOr(cached, fallback('ROUTING_ADAPTER_UNAVAILABLE'))
      }

      const credential = await options.credentialResolver
        .resolve(configuration.credentialReference, tenantId, configuration.providerCode)
        .catch(() => null)
      if (!credential) {
        return staleOr(cached, fallback('ROUTING_CREDENTIAL_UNAVAILABLE'))
      }

      let distance: Readonly<RouteDistance>
      try {
        distance = routeDistanceFrom(
          await provider.route({
            origin: query.origin,
            destination: query.destination,
            profile,
            restrictions,
            timeoutMs,
            configuration: {
              id: configuration.id,
              tenantId,
              providerCode: configuration.providerCode,
              adapterVersion: configuration.adapterVersion,
              adapterSpiVersion: configuration.adapterSpiVersion as RoutingAdapterSpiVersion,
              environment: options.environment,
              credentialReference: configuration.credentialReference,
            },
            credential,
          }),
          query.origin,
          query.destination,
        )
      } catch {
        // An adapter that threw rather than answering is still just an outage.
        distance = fallback('ROUTING_PROVIDER_THREW')
      } finally {
        credential.dispose()
      }

      if (distance.source !== 'ROUTED') {
        // A stale measurement of the real road beats a fresh guess about it:
        // roads change over seasons, and the alternative here is arithmetic.
        return staleOr(cached, distance)
      }

      await persistEstimate(prisma, tenantId, where, distance, now)
      return distance
    },
  }
}

/**
 * Prefers an expired measurement to a straight-line guess.
 *
 * Both are imperfect, but they are imperfect about different things: the cached
 * row is a real road that may have changed, while the estimate is a road that
 * was never measured. On the timescale a TTL expires over, the first is much
 * closer to the truth.
 */
function staleOr(
  cached: { distanceMetres: number; durationSeconds: number | null } | null,
  estimate: Readonly<RouteDistance>,
): Readonly<RouteDistance> {
  if (!cached) return estimate
  return Object.freeze({
    distanceMetres: cached.distanceMetres,
    durationSeconds: cached.durationSeconds,
    source: 'ROUTED' as const,
  })
}

async function loadConfiguration(
  prisma: PrismaClient,
  tenantId: string,
  environment: 'TEST' | 'PRODUCTION',
) {
  return withTenantRead(prisma, tenantId, (transaction) =>
    transaction.routingProviderConfiguration.findFirst({
      where: { tenantId, environment, enabled: true, isDefault: true, healthStatus: 'HEALTHY' },
    }),
  )
}

/**
 * Writes the measurement, and treats a failure to write as unimportant.
 *
 * The distance has already been obtained and the caller is waiting to price an
 * order with it. A cache that could not be updated costs one extra routing call
 * next time, which is not a reason to fail a checkout.
 */
async function persistEstimate(
  prisma: PrismaClient,
  tenantId: string,
  key: {
    tenantId: string
    bakeryBranchId: string
    destinationLatitude: number
    destinationLongitude: number
    profile: RoutingProfile
    avoidTrafficZone: boolean
    avoidOddEvenZone: boolean
    providerCode: string
  },
  distance: Readonly<RouteDistance>,
  now: Date,
): Promise<void> {
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      const existing = await transaction.routeEstimate.findFirst({ where: key })
      if (existing) {
        await transaction.routeEstimate.update({
          where: { id: existing.id },
          data: {
            distanceMetres: distance.distanceMetres,
            durationSeconds: distance.durationSeconds,
            // The guard refuses a re-measurement that does not move forward in
            // time, so a clock that has not ticked keeps the older reading.
            computedAt:
              now > existing.computedAt ? now : new Date(existing.computedAt.getTime() + 1),
          },
        })
        return
      }
      await transaction.routeEstimate.create({
        data: {
          ...key,
          distanceMetres: distance.distanceMetres,
          durationSeconds: distance.durationSeconds,
          computedAt: now,
        },
      })
    })
  } catch {
    // Losing the write to a concurrent identical insert is the common case and
    // is entirely harmless: both wrote the same measurement.
  }
}

/**
 * Resolves `env://ROUTING_*` references, the same form the SMS gateway uses.
 *
 * The prefix is enforced rather than assumed: without it, a configuration row
 * naming `env://DATABASE_URL` would hand the database password to a routing
 * adapter. A routing key is also not a payment credential — it buys distances,
 * not money — which is why `env://` is permitted here at all.
 */
export function createEnvironmentRoutingCredentialResolver(
  environment: Readonly<Record<string, string | undefined>>,
): RoutingCredentialResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const match = /^env:\/(?:\/)?(ROUTING_[A-Z0-9_]{1,120})$/.exec(reference)
      const value = match ? environment[match[1]!] : undefined
      if (!value || value.trim().length === 0) {
        throw new Error('ROUTING_CREDENTIAL_UNAVAILABLE')
      }
      const material = Buffer.from(value.trim(), 'utf8')
      return { material, dispose: () => material.fill(0) }
    },
  })
}

async function withTenantRead<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}
