import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { assignmentProposeCommandSchema } from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { CourierAssignmentError, type CourierAssignmentService } from './courier-assignment.js'

/**
 * One route, and it changes nothing.
 *
 * The proposal is read by a dispatcher who then offers the work through the
 * ordinary delivery and trip routes. Keeping the decision with a person is the
 * same judgement batching made: an optimiser acting on its own would put a rider
 * on a run for a reason nobody chose, and the position it reasoned from is an
 * estimate this system openly labels as one.
 */
const DISPATCH_PERMISSION = ADMIN_PERMISSIONS.ordersManage
const DISPATCH_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }

export interface CourierAssignmentDependencies extends AdminAuthDependencies {
  service: CourierAssignmentService
  now?: () => Date
}

export function registerCourierAssignmentRoutes(
  app: FastifyInstance,
  dependencies: CourierAssignmentDependencies,
): void {
  app.post('/api/v1/admin/courier-assignments/propose', DISPATCH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, DISPATCH_PERMISSION)
    if (!actor) return reply
    const parsed = assignmentProposeCommandSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_ASSIGNMENT_REQUEST', 'The request is invalid.'))
    }
    try {
      const proposal = await dependencies.service.proposeAssignments(
        actor.tenantId,
        parsed.data.branchId === undefined ? {} : { branchId: parsed.data.branchId },
        dependencies.now?.() ?? new Date(),
      )
      return reply.send({ success: true, data: proposal, meta: adminResponseMeta() })
    } catch (error) {
      return assignmentFailure(request, reply, error)
    }
  })
}

const ASSIGNMENT_MESSAGES: Readonly<Record<string, string>> = {
  BRANCH_NOT_FOUND: 'No such branch.',
}

function assignmentFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof CourierAssignmentError) {
    return reply
      .code(error.status)
      .send(
        errorEnvelope(error.code, ASSIGNMENT_MESSAGES[error.code] ?? 'The request was refused.'),
      )
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('BRANCH_NOT_FOUND', 'No such branch.'))
  }
  request.log.error({ err: error }, 'Courier assignment proposal failed')
  return reply.code(503).send(errorEnvelope('DELIVERY_UNAVAILABLE', 'Deliveries are unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
