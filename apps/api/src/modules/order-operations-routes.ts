import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  orderTransitionCommandSchema,
  productionTransitionCommandSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import {
  OrderOperationsError,
  type OrderOperationsService,
  type OrderTransitionCommand,
} from './order-operations.js'

/**
 * The staff surface for moving an order.
 *
 * Each step is its own route rather than one route taking a destination.
 * Accepting an order and cancelling it are different acts with different
 * consequences for a customer who has paid, and they should not differ by one
 * enum value in a body — a typo there would be a refund.
 */
const ORDERS_PERMISSION = ADMIN_PERMISSIONS.ordersManage

// Order operations are the panel's highest-frequency writes: a busy morning is
// an operator working through a queue.
const ORDERS_RATE_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }

export interface OrderOperationsDependencies extends AdminAuthDependencies {
  service: OrderOperationsService
}

type OrderStep = (
  tenantId: string,
  actor: { accountId: string },
  command: OrderTransitionCommand,
  now: Date,
  correlationId: string,
) => Promise<unknown>

export function registerOrderOperationsRoutes(
  app: FastifyInstance,
  dependencies: OrderOperationsDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  const step = (path: string, run: (service: OrderOperationsService) => OrderStep): void => {
    app.post<{ Params: { orderId: string } }>(
      `/api/v1/admin/orders/:orderId/${path}`,
      ORDERS_RATE_LIMIT,
      async (request, reply) => {
        const actor = await authenticatedStaff(request, reply, dependencies, ORDERS_PERMISSION)
        if (!actor) return reply
        const parsed = orderTransitionCommandSchema.safeParse(request.body)
        if (!parsed.success) {
          return reply
            .code(400)
            .send(errorEnvelope('INVALID_ORDER_COMMAND', 'The command is invalid.'))
        }

        try {
          const result = await run(dependencies.service)(
            actor.tenantId,
            { accountId: actor.accountId },
            { orderId: request.params.orderId, reason: parsed.data.reason },
            currentTime(),
            randomUUID(),
          )
          return reply.send({ success: true, data: result, meta: adminResponseMeta() })
        } catch (error) {
          return operationsFailure(request, reply, error)
        }
      },
    )
  }

  step('accept', (service) => service.accept)
  step('reject', (service) => service.reject)
  step('start-fulfillment', (service) => service.startFulfillment)
  step('complete', (service) => service.complete)

  /**
   * Cancelling and refunding in one act, because they are one decision.
   * Splitting them would let an operator cancel and forget the money, which is
   * the failure that matters to a customer.
   */
  app.post<{ Params: { orderId: string } }>(
    '/api/v1/admin/orders/:orderId/cancel',
    ORDERS_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, ORDERS_PERMISSION)
      if (!actor) return reply
      const parsed = orderTransitionCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_ORDER_COMMAND', 'The command is invalid.'))
      }

      try {
        const result = await dependencies.service.cancelWithRefund(
          actor.tenantId,
          { accountId: actor.accountId },
          { orderId: request.params.orderId, reason: parsed.data.reason },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: result, meta: adminResponseMeta() })
      } catch (error) {
        return operationsFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { orderId: string } }>(
    '/api/v1/admin/orders/:orderId/production',
    ORDERS_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, ORDERS_PERMISSION)
      if (!actor) return reply
      const parsed = productionTransitionCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PRODUCTION_COMMAND', 'The command is invalid.'))
      }

      try {
        const result = await dependencies.service.advanceProduction(
          actor.tenantId,
          { accountId: actor.accountId },
          {
            orderId: request.params.orderId,
            to: parsed.data.to,
            reason: parsed.data.reason,
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: result, meta: adminResponseMeta() })
      } catch (error) {
        return operationsFailure(request, reply, error)
      }
    },
  )
}

const OPERATIONS_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_OPERATION_FORBIDDEN: 'This account may not operate orders.',
  ORDER_NOT_FOUND: 'No such order.',
  ORDER_NOT_PAID: 'This order has not been paid for yet.',
  TRANSITION_NOT_ALLOWED: 'That step is not available from the order current state.',
  TRANSITION_NOT_PERMITTED: 'Staff may not take that step.',
  PRODUCTION_NOT_APPLICABLE: 'Production does not apply to an order in this state.',
  ORDER_WRITE_CONFLICT: 'Someone else moved this order first. Reload and try again.',
  REFUND_QUARANTINED:
    'The refund was refused and needs a human. The order was left as it is rather than looking finished.',
}

function operationsFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof OrderOperationsError) {
    return reply
      .code(error.status)
      .send(
        errorEnvelope(error.code, OPERATIONS_MESSAGES[error.code] ?? 'The request was refused.'),
      )
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('ORDER_NOT_FOUND', 'No such order.'))
  }
  request.log.error({ err: error }, 'Order operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('ORDER_OPERATIONS_UNAVAILABLE', 'Order operations are unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
