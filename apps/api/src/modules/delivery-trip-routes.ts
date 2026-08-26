import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  tripCreateCommandSchema,
  tripDispatchCommandSchema,
  tripProposeCommandSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { DeliveryTripError, type DeliveryTripService } from './delivery-trips.js'

/**
 * The dispatcher's side of batching: see a proposal, commit it, offer it.
 *
 * Three steps rather than one, because batching decides that a customer will
 * wait longer than they otherwise would. That decision belongs to a person who
 * can see what it costs and what it saves, not to a background job whose first
 * visible output is a late delivery.
 */
const DISPATCH_PERMISSION = ADMIN_PERMISSIONS.ordersManage
const DISPATCH_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }

export interface DeliveryTripDependencies extends AdminAuthDependencies {
  service: DeliveryTripService
  now?: () => Date
}

export function registerDeliveryTripRoutes(
  app: FastifyInstance,
  dependencies: DeliveryTripDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  app.get<{ Querystring: { all?: string } }>(
    '/api/v1/admin/delivery-trips',
    DISPATCH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
      if (!actor) return reply
      try {
        const trips = await dependencies.service.listTrips(
          actor.tenantId,
          request.query.all !== 'true',
        )
        return reply.send({ success: true, data: trips, meta: adminResponseMeta() })
      } catch (error) {
        return tripFailure(request, reply, error)
      }
    },
  )

  app.post('/api/v1/admin/delivery-trips/propose', DISPATCH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
    if (!actor) return reply
    const parsed = tripProposeCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('INVALID_TRIP_REQUEST', 'The request is invalid.'))
    }
    try {
      // Writes nothing. A dispatcher may look at the saving and decline it.
      const trip = await dependencies.service.proposeTrip(
        actor.tenantId,
        { anchorTaskId: parsed.data.anchorTaskId },
        currentTime(),
      )
      return reply.send({ success: true, data: trip, meta: adminResponseMeta() })
    } catch (error) {
      return tripFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/delivery-trips', DISPATCH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
    if (!actor) return reply
    const parsed = tripCreateCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('INVALID_TRIP_REQUEST', 'The request is invalid.'))
    }
    try {
      const trip = await dependencies.service.createTrip(
        actor.tenantId,
        { accountId: actor.accountId },
        { taskIds: parsed.data.taskIds },
        currentTime(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: trip, meta: adminResponseMeta() })
    } catch (error) {
      return tripFailure(request, reply, error)
    }
  })

  app.post<{ Params: { tripId: string } }>(
    '/api/v1/admin/delivery-trips/:tripId/dispatch',
    DISPATCH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
      if (!actor) return reply
      const parsed = tripDispatchCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_TRIP_REQUEST', 'The request is invalid.'))
      }
      try {
        const trip = await dependencies.service.dispatchTrip(
          actor.tenantId,
          { accountId: actor.accountId },
          { tripId: request.params.tripId, courierId: parsed.data.courierId },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: trip, meta: adminResponseMeta() })
      } catch (error) {
        return tripFailure(request, reply, error)
      }
    },
  )
}

/**
 * A dispatcher refused a batch needs to know which rule refused it — "this drop
 * would arrive late" is something they can act on, and a bare 409 is not.
 */
const TRIP_MESSAGES: Readonly<Record<string, string>> = {
  TRIP_NOT_FOUND: 'No such trip.',
  TRIP_EMPTY: 'A trip needs at least one delivery.',
  TRIP_TOO_LARGE: 'That is more deliveries than one courier may carry.',
  TRIP_BRANCH_MISMATCH: 'Every delivery on a trip must be collected from the same branch.',
  TRIP_WOULD_ARRIVE_LATE: 'One of these deliveries would miss its promised time on this trip.',
  INVALID_TRIP_TRANSITION: 'This trip has already left, or has been cancelled.',
  INVALID_TRIP_PLAN: 'That set of deliveries cannot be planned as one trip.',
  DELIVERY_NOT_FOUND: 'No such delivery.',
  DELIVERY_NOT_BATCHABLE: 'That delivery is already assigned and cannot join a trip.',
  DELIVERY_ALREADY_ON_A_TRIP: 'That delivery is already on another trip.',
  DELIVERY_HAS_NO_LOCATION: 'That delivery has no address to plan against.',
  COURIER_NOT_FOUND: 'No such courier.',
  COURIER_UNAVAILABLE: 'That courier cannot take a trip right now.',
}

function tripFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DeliveryTripError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, TRIP_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('TRIP_NOT_FOUND', 'No such trip.'))
  }
  request.log.error({ err: error }, 'Delivery trip operation failed')
  return reply.code(503).send(errorEnvelope('DELIVERY_UNAVAILABLE', 'Deliveries are unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
