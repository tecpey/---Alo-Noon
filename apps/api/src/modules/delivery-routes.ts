import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  courierReportCommandSchema,
  deliveryOfferCommandSchema,
  deliveryReleaseCommandSchema,
  courierResponseCommandSchema,
} from '@alo-noon/contracts'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { authenticateRequest } from './auth.js'
import { DeliveryError, type CourierActor, type DeliveryService } from './delivery.js'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

/**
 * Two surfaces over one service.
 *
 * The dispatcher's routes sit under `/admin` and are gated on a staff
 * permission. The courier's routes are not: a courier is not a staff account and
 * holds no admin grant. Their authority is the assignment itself — they may act
 * on an order that was offered to them and on nothing else — and the service
 * checks that against the row on every write, which is why the courier routes
 * carry no permission of their own to be wrong about.
 */
const DISPATCH_PERMISSION = ADMIN_PERMISSIONS.ordersManage

// A dispatch board is refreshed constantly during a rush; a courier taps a few
// buttons per delivery.
const DISPATCH_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }
const COURIER_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }

export interface DeliveryDependencies extends AdminAuthDependencies {
  service: DeliveryService
}

export function registerDeliveryRoutes(
  app: FastifyInstance,
  dependencies: DeliveryDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  // -- Dispatcher ----------------------------------------------------------

  app.get<{ Querystring: { all?: string } }>(
    '/api/v1/admin/deliveries',
    DISPATCH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
      if (!actor) return reply
      try {
        // Finished deliveries are excluded unless asked for: a board that grows
        // forever stops being a board.
        const tasks = await dependencies.service.listTasks(
          actor.tenantId,
          request.query.all !== 'true',
        )
        return reply.send({ success: true, data: tasks, meta: adminResponseMeta() })
      } catch (error) {
        return deliveryFailure(request, reply, error)
      }
    },
  )

  app.get('/api/v1/admin/couriers', DISPATCH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
    if (!actor) return reply
    try {
      const couriers = await dependencies.service.listCouriers(actor.tenantId)
      return reply.send({ success: true, data: couriers, meta: adminResponseMeta() })
    } catch (error) {
      return deliveryFailure(request, reply, error)
    }
  })

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/admin/deliveries/:taskId/offer',
    DISPATCH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
      if (!actor) return reply
      const parsed = deliveryOfferCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_DELIVERY_COMMAND', 'The command is invalid.'))
      }
      try {
        const task = await dependencies.service.offer(
          actor.tenantId,
          { accountId: actor.accountId },
          { taskId: request.params.taskId, courierId: parsed.data.courierId },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: task, meta: adminResponseMeta() })
      } catch (error) {
        return deliveryFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/admin/deliveries/:taskId/release',
    DISPATCH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
      if (!actor) return reply
      const parsed = deliveryReleaseCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_DELIVERY_COMMAND', 'The command is invalid.'))
      }
      try {
        const task = await dependencies.service.release(
          actor.tenantId,
          { accountId: actor.accountId },
          { taskId: request.params.taskId, reason: parsed.data.reason },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: task, meta: adminResponseMeta() })
      } catch (error) {
        return deliveryFailure(request, reply, error)
      }
    },
  )

  // -- Courier -------------------------------------------------------------

  /**
   * Turns a session into the courier it belongs to.
   *
   * Takes the session rather than the request on purpose: `authenticateRequest`
   * is called inside each handler, where the lint rule guarding tenant
   * resolution can see it. A wrapper that made the call on the handler's behalf
   * would hide it from exactly the check that matters.
   */
  const courierFor = async (
    session: { tenantId: string; accountId: string } | null,
    reply: FastifyReply,
  ): Promise<{ tenantId: string; courier: CourierActor } | null> => {
    if (!session) {
      reply.code(401).send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid session is required.'))
      return null
    }
    // A courier signs in with the same one-time code as anyone else; what makes
    // them a courier is a record carrying their number. An account with no such
    // record is simply not a courier, which is a 403 rather than a 401 — the
    // session is perfectly valid, it just is not this person's app.
    const courier = await dependencies.service.findCourierForAccount(
      session.tenantId,
      session.accountId,
    )
    if (!courier) {
      reply
        .code(403)
        .send(errorEnvelope('NOT_A_COURIER', 'This account is not registered as a courier.'))
      return null
    }
    return { tenantId: session.tenantId, courier }
  }

  app.get('/api/v1/courier/deliveries', COURIER_LIMIT, async (request, reply) => {
    const context = await courierFor(await authenticateRequest(request, dependencies.auth), reply)
    if (!context) return reply
    try {
      const tasks = await dependencies.service.listCourierTasks(context.tenantId, context.courier)
      return reply.send({ success: true, data: tasks, meta: adminResponseMeta() })
    } catch (error) {
      return deliveryFailure(request, reply, error)
    }
  })

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/courier/deliveries/:taskId/respond',
    COURIER_LIMIT,
    async (request, reply) => {
      const context = await courierFor(await authenticateRequest(request, dependencies.auth), reply)
      if (!context) return reply
      const parsed = courierResponseCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_DELIVERY_COMMAND', 'The command is invalid.'))
      }
      try {
        const task = await dependencies.service.respond(
          context.tenantId,
          context.courier,
          { taskId: request.params.taskId, accept: parsed.data.accept },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: task, meta: adminResponseMeta() })
      } catch (error) {
        return deliveryFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/courier/deliveries/:taskId/report',
    COURIER_LIMIT,
    async (request, reply) => {
      const context = await courierFor(await authenticateRequest(request, dependencies.auth), reply)
      if (!context) return reply
      const parsed = courierReportCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_DELIVERY_COMMAND', 'The command is invalid.'))
      }
      try {
        const task = await dependencies.service.report(
          context.tenantId,
          context.courier,
          {
            taskId: request.params.taskId,
            to: parsed.data.to,
            reasonCode: parsed.data.reasonCode,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: task, meta: adminResponseMeta() })
      } catch (error) {
        return deliveryFailure(request, reply, error)
      }
    },
  )
}

const DELIVERY_MESSAGES: Readonly<Record<string, string>> = {
  DISPATCH_FORBIDDEN: 'This account may not dispatch deliveries.',
  DELIVERY_NOT_FOUND: 'No such delivery.',
  COURIER_NOT_FOUND: 'No such courier.',
  COURIER_UNAVAILABLE: 'That courier is not available for work right now.',
  OFFER_NOT_OPEN: 'That offer is no longer open.',
  DELIVERY_NOT_YOURS: 'This delivery is not assigned to you.',
  FAILURE_REASON_REQUIRED: 'A failed delivery needs a reason.',
  DELIVERY_STEP_NOT_ALLOWED: 'That step is not available from the delivery current state.',
  DELIVERY_STEP_NOT_PERMITTED: 'That step is not yours to take.',
  DELIVERY_WRITE_CONFLICT: 'Someone else moved this delivery first. Reload and try again.',
}

function deliveryFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DeliveryError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, DELIVERY_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('DELIVERY_NOT_FOUND', 'No such delivery.'))
  }
  request.log.error({ err: error }, 'Delivery operation failed')
  return reply.code(503).send(errorEnvelope('DELIVERY_UNAVAILABLE', 'Deliveries are unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
