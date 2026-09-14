import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  addressCreateSchema,
  placeSearchQuerySchema,
  reverseGeocodeQuerySchema,
  type AddressCreate,
  type AddressSummary,
  type ErrorEnvelope,
  type PlaceCandidate,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'

import { authenticatedCustomer } from './commerce.js'
import { geoJsonContainsPoint } from './discovery.js'
import type { AuthDependencies } from './auth.js'
import type { RoutingService } from './routing.js'

export interface AddressRepository {
  list(tenantId: string, customerId: string): Promise<AddressSummary[]>
  create(
    tenantId: string,
    customerId: string,
    input: AddressCreate,
    now: Date,
    correlationId: string,
  ): Promise<AddressSummary>
}

export interface AddressDependencies {
  repository: AddressRepository
  auth: AuthDependencies
  now?: () => Date
  /**
   * Optional, and absent is a supported state rather than a misconfiguration: a
   * tenant that has not bought mapping still takes orders from the satellite
   * position, exactly as every tenant did before this existed. The routes stay
   * mounted and answer `available: false`, so the interface can hide the search
   * box for that tenant instead of offering one that always fails.
   */
  places?: RoutingService
  /**
   * Where to look first, per city — the mean of that city's active branches.
   *
   * A city has no coordinates of its own in this schema, and its branches do.
   * The mean of them is not a civic centre, but it is genuinely "where this
   * tenant operates in this city", which is all a search bias has to be.
   */
  cityBias?: (tenantId: string, cityId: string) => Promise<Coordinates | null>
}

interface Coordinates {
  latitude: number
  longitude: number
}

export class AddressError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(code)
  }
}

export function registerAddressRoutes(
  app: FastifyInstance,
  dependencies: AddressDependencies,
): void {
  app.get('/api/v1/addresses', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    try {
      return {
        success: true,
        data: await dependencies.repository.list(customer.tenantId, customer.customerId),
        meta: responseMeta(),
      }
    } catch (error) {
      return addressFailure(request, reply, error)
    }
  })

  app.post('/api/v1/addresses', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    const parsed = addressCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('INVALID_ADDRESS_REQUEST', 'Address is invalid.'))
    }
    try {
      const address = await dependencies.repository.create(
        customer.tenantId,
        customer.customerId,
        parsed.data,
        dependencies.now?.() ?? new Date(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: address, meta: responseMeta() })
    } catch (error) {
      return addressFailure(request, reply, error)
    }
  })

  /**
   * Both place routes are capped well below the global limit.
   *
   * Every call here spends the tenant's mapping quota, and a search box fires
   * one per few keystrokes. The global 600/minute is sized for reads that cost
   * nothing; leaving these under it would let one signed-in customer, or one
   * loop with a stolen session, empty a bakery's account for the month.
   *
   * Thirty a minute is far more than typing an address takes and far less than
   * a script needs to be worth running.
   */
  const PLACES_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

  app.get('/api/v1/places/search', PLACES_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const parsed = placeSearchQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_PLACE_SEARCH', 'The search term is invalid.'))
    }
    if (!dependencies.places) {
      return { success: true, data: { available: false, candidates: [] }, meta: responseMeta() }
    }

    // Resolved before the paid call, and a failure to resolve it is not fatal:
    // an unbiased search is worse than a biased one and much better than none.
    const bias =
      parsed.data.cityId && dependencies.cityBias
        ? await dependencies.cityBias(customer.tenantId, parsed.data.cityId).catch(() => null)
        : null

    const result = await dependencies.places.searchPlaces(customer.tenantId, {
      term: parsed.data.term,
      ...(bias && { bias }),
    })
    if (result.outcome === 'UNAVAILABLE') {
      // Distinct from "no mapping configured": this one is worth retrying, and
      // the customer should be told to try again rather than told to give up.
      request.log.warn({ reasonCode: result.reasonCode }, 'Place search unavailable')
      return reply
        .code(503)
        .send(errorEnvelope('PLACE_SEARCH_UNAVAILABLE', 'Address search is temporarily down.'))
    }
    return {
      success: true,
      data: {
        available: result.outcome !== 'UNSUPPORTED',
        candidates: (result.candidates ?? []).flatMap(toPlaceCandidate),
      },
      meta: responseMeta(),
    }
  })

  app.get('/api/v1/places/reverse', PLACES_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const query = request.query as Record<string, unknown>
    const parsed = reverseGeocodeQuerySchema.safeParse({
      latitude: Number(query['latitude']),
      longitude: Number(query['longitude']),
    })
    if (!parsed.success) {
      // Also the cheap guard: a coordinate outside the serviceable box could
      // never become an address here, so nothing is spent asking about it.
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_REVERSE_QUERY', 'The coordinates are invalid.'))
    }
    if (!dependencies.places) {
      return {
        success: true,
        data: { available: false, formattedAddress: null },
        meta: responseMeta(),
      }
    }

    const result = await dependencies.places.reverseGeocode(customer.tenantId, {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
    })
    if (result.outcome === 'UNAVAILABLE') {
      request.log.warn({ reasonCode: result.reasonCode }, 'Reverse geocode unavailable')
      return reply
        .code(503)
        .send(errorEnvelope('REVERSE_UNAVAILABLE', 'Address lookup is temporarily down.'))
    }
    return {
      success: true,
      data: {
        available: result.outcome !== 'UNSUPPORTED',
        formattedAddress: result.formattedAddress ?? null,
      },
      meta: responseMeta(),
    }
  })
}

/**
 * Drops a candidate the customer could not actually use.
 *
 * The provider answers about the whole country; this product serves a box. A
 * result outside it can be selected and then refused by address creation, which
 * reads as the shop being broken rather than as the place being out of range —
 * so it is never offered. Returns an array so the caller can `flatMap`.
 */
function toPlaceCandidate(candidate: {
  title: string
  address: string | null
  coordinates: { latitude: number; longitude: number }
  distanceMetres: number | null
}): PlaceCandidate[] {
  const { latitude, longitude } = candidate.coordinates
  if (latitude < 35 || latitude > 38.5 || longitude < 49 || longitude > 54.5) return []
  return [
    {
      title: candidate.title.slice(0, 200),
      address: candidate.address ? candidate.address.slice(0, 500) : null,
      latitude,
      longitude,
      distanceMetres: candidate.distanceMetres,
    },
  ]
}

export function createPrismaAddressRepository(prisma: PrismaClient): AddressRepository {
  return {
    async list(tenantId, customerId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const addresses = await transaction.address.findMany({
          where: {
            tenantId,
            customerId,
            archivedAt: null,
            verificationState: { not: 'REJECTED' },
            serviceAreaId: { not: null },
            operationalZoneId: { not: null },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        })
        return addresses.map(toAddressSummary)
      })
    },

    async create(tenantId, customerId, input, now, correlationId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const latitude = normalizeCoordinate(input.latitude)
        const longitude = normalizeCoordinate(input.longitude)
        const replay = await transaction.address.findFirst({
          where: { tenantId, customerId, requestIdempotencyKey: input.idempotencyKey },
        })
        if (replay) {
          if (!sameAddressPayload(replay, input)) {
            throw new AddressError('IDEMPOTENCY_KEY_CONFLICT', 409)
          }
          if (!replay.serviceAreaId || !replay.operationalZoneId || replay.archivedAt) {
            throw new AddressError('ADDRESS_NOT_AVAILABLE', 404)
          }
          return toAddressSummary(replay)
        }

        const city = await transaction.city.findFirst({
          where: { id: input.cityId, tenantId, isActive: true },
          select: { id: true },
        })
        if (!city) throw new AddressError('ADDRESS_NOT_SERVICEABLE', 422)

        const areas = await transaction.serviceArea.findMany({
          where: {
            tenantId,
            isActive: true,
            operationalZone: { is: { cityId: input.cityId, tenantId, isActive: true } },
          },
          select: { id: true, operationalZoneId: true, boundaryGeoJson: true },
        })
        const matches = areas.filter((area) =>
          geoJsonContainsPoint(area.boundaryGeoJson, longitude, latitude),
        )
        if (matches.length !== 1) {
          throw new AddressError(
            matches.length === 0 ? 'ADDRESS_NOT_SERVICEABLE' : 'SERVICE_AREA_AMBIGUOUS',
            422,
          )
        }
        const match = matches[0]!
        const address = await transaction.address.create({
          data: {
            tenantId,
            customerId,
            cityId: input.cityId,
            operationalZoneId: match.operationalZoneId,
            serviceAreaId: match.id,
            requestIdempotencyKey: input.idempotencyKey,
            label: input.label,
            recipientName: input.recipientName,
            recipientPhoneE164: input.recipientPhone,
            addressLine: input.addressLine,
            ...(input.postalCode && { postalCode: input.postalCode }),
            latitude,
            longitude,
            ...(input.deliveryInstructions && { deliveryInstructions: input.deliveryInstructions }),
            verificationState: 'CUSTOMER_CONFIRMED',
            verifiedAt: now,
          },
        })
        await Promise.all([
          transaction.auditEvent.create({
            data: {
              tenantId,
              actorType: 'CUSTOMER',
              actorId: customerId,
              action: 'customer.address_added',
              entityType: 'address',
              entityId: address.id,
              summary: 'Customer delivery address added',
              correlationId,
              occurredAt: now,
            },
          }),
          transaction.domainEventOutbox.create({
            data: {
              tenantId,
              eventId: address.id,
              name: 'customer.address_added',
              aggregateType: 'address',
              aggregateId: address.id,
              actorType: 'CUSTOMER',
              actorId: customerId,
              correlationId,
              consentBasis: 'TRANSACTIONAL',
              occurredAt: now,
              payload: {
                addressId: address.id,
                customerId,
                cityId: input.cityId,
                serviceAreaId: match.id,
                operationalZoneId: match.operationalZoneId,
              },
            },
          }),
        ])
        return toAddressSummary(address)
      })
    },
  }
}

/**
 * Where a city is, according to the branches the tenant actually runs in it.
 *
 * The mean of their coordinates. Crude on purpose — its only job is to stop a
 * search for a street name that exists in forty Iranian towns from answering
 * with the one in Tehran. A tenant with no active branch in the city gets no
 * bias rather than a fabricated one.
 */
export function createPrismaCityBiasResolver(
  prisma: PrismaClient,
): (tenantId: string, cityId: string) => Promise<Coordinates | null> {
  return async (tenantId, cityId) =>
    withTenant(prisma, tenantId, async (transaction) => {
      const branches = await transaction.bakeryBranch.findMany({
        // Suspended and onboarding branches count: the question is where this
        // tenant operates in this city, not which door is open this minute, and
        // a bias that moves when a branch closes for the afternoon would
        // reorder a customer's search results for no reason they could see.
        where: { tenantId, cityId, operationalStatus: { not: 'CLOSED' } },
        select: { latitude: true, longitude: true },
      })
      if (branches.length === 0) return null
      const total = branches.reduce(
        (sum, branch) => ({
          latitude: sum.latitude + Number(branch.latitude),
          longitude: sum.longitude + Number(branch.longitude),
        }),
        { latitude: 0, longitude: 0 },
      )
      return {
        latitude: total.latitude / branches.length,
        longitude: total.longitude / branches.length,
      }
    })
}

function toAddressSummary(address: {
  id: string
  cityId: string
  serviceAreaId: string | null
  operationalZoneId: string | null
  label: string
  recipientName: string
  recipientPhoneE164: string
  addressLine: string
  postalCode: string | null
  latitude: unknown
  longitude: unknown
  deliveryInstructions: string | null
  verificationState: AddressSummary['verificationStatus']
  createdAt: Date
}): AddressSummary {
  if (!address.serviceAreaId || !address.operationalZoneId) {
    throw new AddressError('ADDRESS_PROVENANCE_INCOMPLETE', 503)
  }
  return {
    id: address.id,
    cityId: address.cityId,
    serviceAreaId: address.serviceAreaId,
    operationalZoneId: address.operationalZoneId,
    label: address.label,
    recipientName: address.recipientName,
    recipientPhone: address.recipientPhoneE164,
    addressLine: address.addressLine,
    ...(address.postalCode && { postalCode: address.postalCode }),
    latitude: Number(address.latitude),
    longitude: Number(address.longitude),
    ...(address.deliveryInstructions && { deliveryInstructions: address.deliveryInstructions }),
    verificationStatus: address.verificationState,
    createdAt: address.createdAt.toISOString(),
  }
}

function sameAddressPayload(
  address: Parameters<typeof toAddressSummary>[0],
  input: AddressCreate,
): boolean {
  return (
    address.cityId === input.cityId &&
    address.label === input.label &&
    address.recipientName === input.recipientName &&
    address.recipientPhoneE164 === input.recipientPhone &&
    address.addressLine === input.addressLine &&
    address.postalCode === (input.postalCode ?? null) &&
    Number(address.latitude) === normalizeCoordinate(input.latitude) &&
    Number(address.longitude) === normalizeCoordinate(input.longitude) &&
    address.deliveryInstructions === (input.deliveryInstructions ?? null)
  )
}

function normalizeCoordinate(value: number): number {
  return Number(value.toFixed(7))
}

async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'Serializable' },
  )
}

function unauthorized(reply: { code(status: number): { send(payload: ErrorEnvelope): unknown } }) {
  return reply
    .code(401)
    .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
}

function addressFailure(
  request: { log: { error(input: unknown, message: string): void } },
  reply: { code(status: number): { send(payload: ErrorEnvelope): unknown } },
  error: unknown,
) {
  if (error instanceof AddressError) {
    const messages: Record<string, string> = {
      IDEMPOTENCY_KEY_CONFLICT: 'The idempotency key was already used.',
      ADDRESS_NOT_AVAILABLE: 'The address is not available.',
      ADDRESS_NOT_SERVICEABLE: 'The address is outside the available service area.',
      SERVICE_AREA_AMBIGUOUS: 'The service area could not be determined safely.',
      ADDRESS_PROVENANCE_INCOMPLETE: 'The address cannot be used currently.',
    }
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, messages[error.code] ?? 'Address request rejected.'))
  }
  request.log.error({ err: error }, 'Address request failed')
  return reply
    .code(503)
    .send(
      errorEnvelope('ADDRESS_SERVICE_UNAVAILABLE', 'Address service is temporarily unavailable.'),
    )
}

function responseMeta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}
function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
