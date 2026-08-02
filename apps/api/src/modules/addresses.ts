import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  addressCreateSchema,
  type AddressCreate,
  type AddressSummary,
  type ErrorEnvelope,
  type ResponseMeta,
} from '@alo-noon/contracts'
import type { Prisma, PrismaClient } from '@alo-noon/database'

import { authenticatedCustomer } from './commerce.js'
import { geoJsonContainsPoint } from './discovery.js'
import type { AuthDependencies } from './auth.js'

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
