import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  branchOrderStepCommandSchema,
  branchProductionCommandSchema,
  branchQueueQuerySchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedBranchStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import type { BranchOperationsService } from './branch-operations.js'
import {
  OrderOperationsError,
  type OrderOperationsService,
  type OrderTransitionCommand,
} from './order-operations.js'

/**
 * The counter, for a bakery partner's own staff.
 *
 * Separate from `/api/v1/admin` on purpose, and not a filtered view of it. The
 * admin panel's contract is "you hold this permission across the tenant"; this
 * surface's is "you hold it at these branches and nowhere else", and one set of
 * routes serving both would be a single missing `if` away from showing a partner
 * every competitor's queue.
 *
 * No route here takes a branch id. The branches come from the session's own
 * grants, resolved by `authenticatedBranchStaff` — a branch a client could name
 * is a branch any client could name.
 *
 * A partner can move their own orders and read their own money. They cannot
 * cancel-with-refund: giving a customer's money back is the platform's decision,
 * not the shop's, and a bakery that could refund on its own could refund an
 * order it simply did not want to bake. Rejecting is the shop's answer to that,
 * and the platform's refund follows it.
 */
const QUEUE_PERMISSION = ADMIN_PERMISSIONS.ordersRead
const STEP_PERMISSION = ADMIN_PERMISSIONS.ordersManage
const EARNINGS_PERMISSION = ADMIN_PERMISSIONS.reportsRead

// A counter on a busy morning works through a queue by hand. Generous enough to
// never be felt, tight enough to bound a stolen session.
const BRANCH_RATE_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }

export interface BranchDependencies extends AdminAuthDependencies {
  service: BranchOperationsService
  orders: OrderOperationsService
}

type OrderStep = (
  tenantId: string,
  actor: { accountId: string; branchIds?: readonly string[] },
  command: OrderTransitionCommand,
  now: Date,
  correlationId: string,
) => Promise<unknown>

export function registerBranchRoutes(app: FastifyInstance, dependencies: BranchDependencies): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  app.get('/api/v1/branch/context', BRANCH_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedBranchStaff(request, reply, dependencies, QUEUE_PERMISSION)
    if (!actor) return reply
    try {
      const branches = await dependencies.service.context(actor.tenantId, actor.branchIds)
      return reply.send({ success: true, data: branches, meta: adminResponseMeta() })
    } catch (error) {
      return branchFailure(request, reply, error)
    }
  })

  app.get('/api/v1/branch/orders', BRANCH_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedBranchStaff(request, reply, dependencies, QUEUE_PERMISSION)
    if (!actor) return reply
    const parsed = branchQueueQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_BRANCH_QUERY', 'That queue request is not valid.'))
    }

    try {
      const orders = await dependencies.service.queue(actor.tenantId, actor.branchIds, parsed.data)
      return reply.send({ success: true, data: orders, meta: adminResponseMeta() })
    } catch (error) {
      return branchFailure(request, reply, error)
    }
  })

  app.get('/api/v1/branch/earnings', BRANCH_RATE_LIMIT, async (request, reply) => {
    // A separate permission from the queue: the counter clerk who accepts orders
    // and the owner who reads what the branch made are different people, and the
    // roles say so.
    const actor = await authenticatedBranchStaff(request, reply, dependencies, EARNINGS_PERMISSION)
    if (!actor) return reply
    try {
      const earnings = await dependencies.service.earnings(actor.tenantId, actor.branchIds)
      return reply.send({ success: true, data: earnings, meta: adminResponseMeta() })
    } catch (error) {
      return branchFailure(request, reply, error)
    }
  })

  const step = (path: string, run: (service: OrderOperationsService) => OrderStep): void => {
    app.post<{ Params: { orderId: string } }>(
      `/api/v1/branch/orders/:orderId/${path}`,
      BRANCH_RATE_LIMIT,
      async (request, reply) => {
        const actor = await authenticatedBranchStaff(request, reply, dependencies, STEP_PERMISSION)
        if (!actor) return reply
        const parsed = branchOrderStepCommandSchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          return reply
            .code(400)
            .send(errorEnvelope('INVALID_ORDER_COMMAND', 'The command is invalid.'))
        }

        try {
          const result = await run(dependencies.orders)(
            actor.tenantId,
            { accountId: actor.accountId, branchIds: actor.branchIds },
            {
              orderId: request.params.orderId,
              reason: parsed.data.reason ?? DEFAULT_REASONS[path]!,
            },
            currentTime(),
            randomUUID(),
          )
          return reply.send({ success: true, data: result, meta: adminResponseMeta() })
        } catch (error) {
          return branchFailure(request, reply, error)
        }
      },
    )
  }

  step('accept', (service) => service.accept)
  step('reject', (service) => service.reject)
  // Handing the bread to the courier is the shop's own act and the moment its
  // part is done. Completion is not here: whether the bread reached the door is
  // the courier's fact to record, not the baker's.
  step('start-fulfillment', (service) => service.startFulfillment)

  app.post<{ Params: { orderId: string } }>(
    '/api/v1/branch/orders/:orderId/production',
    BRANCH_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedBranchStaff(request, reply, dependencies, STEP_PERMISSION)
      if (!actor) return reply
      const parsed = branchProductionCommandSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_PRODUCTION_COMMAND', 'The command is invalid.'))
      }

      try {
        const result = await dependencies.orders.advanceProduction(
          actor.tenantId,
          { accountId: actor.accountId, branchIds: actor.branchIds },
          {
            orderId: request.params.orderId,
            to: parsed.data.to,
            reason: parsed.data.reason ?? 'به‌روزرسانی تولید از پنل نانوایی',
          },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: result, meta: adminResponseMeta() })
      } catch (error) {
        return branchFailure(request, reply, error)
      }
    },
  )
}

/**
 * What the audit records when the counter did not say.
 *
 * Persian, because the person who took the step reads Persian and the audit
 * trail is read by their manager, not by a log parser.
 */
const DEFAULT_REASONS: Readonly<Record<string, string>> = {
  accept: 'پذیرش از پنل نانوایی',
  reject: 'رد سفارش از پنل نانوایی',
  'start-fulfillment': 'تحویل به پیک از پنل نانوایی',
}

const BRANCH_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_NOT_FOUND: 'No such order at this branch.',
  ORDER_NOT_PAID: 'This order has not been paid for yet.',
  ORDER_OPERATION_FORBIDDEN: 'This account may not operate orders at this branch.',
  TRANSITION_NOT_ALLOWED: 'That step is not available from the order current state.',
  TRANSITION_NOT_PERMITTED: 'Staff may not take that step.',
  PRODUCTION_NOT_APPLICABLE: 'Production does not apply to an order in this state.',
  ORDER_WRITE_CONFLICT: 'Someone else moved this order first. Reload and try again.',
}

function branchFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof OrderOperationsError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, BRANCH_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('ORDER_NOT_FOUND', 'No such order at this branch.'))
  }
  request.log.error({ err: error }, 'Branch operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('BRANCH_UNAVAILABLE', 'The branch panel is temporarily unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
