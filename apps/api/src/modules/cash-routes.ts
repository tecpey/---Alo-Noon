import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { cashRemittanceCommandSchema } from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { CashOnDeliveryError, type CashOnDeliveryService } from './cash-on-delivery.js'
import type { EngagementService } from './engagement.js'

/**
 * The cash desk.
 *
 * Two surfaces, and between them they answer the question a delivery business
 * asks itself every evening: how much of today's money is still out on the
 * road, and with whom — and then, when a courier walks in, recording that it
 * came back.
 *
 * Both sit behind `admin.orders.manage` rather than a reporting permission.
 * Counting cash is an operational act with a person's name against it, not a
 * report somebody browses.
 */

export interface CashRouteDependencies extends AdminAuthDependencies {
  service: CashOnDeliveryService
  /**
   * Branch quality rides along here rather than in its own module: it is the
   * other number an operator checks at the same desk, and one more route file
   * for one read would be ceremony without benefit.
   */
  engagement: EngagementService
  now?: () => Date
}

const CASH_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export function registerCashRoutes(
  app: FastifyInstance,
  dependencies: CashRouteDependencies,
): void {
  /**
   * What every courier is carrying right now.
   *
   * Derived from postings rather than from a running total on the courier
   * record: a number that is computed cannot drift away from the ledger, and a
   * number that is stored eventually does.
   */
  app.get('/api/v1/admin/cash/outstanding', CASH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      ADMIN_PERMISSIONS.ordersManage,
    )
    if (!actor) return reply

    try {
      const positions = await dependencies.service.outstandingByCourier(actor.tenantId)
      return reply.send({
        success: true,
        data: positions.map((position) => ({
          courierId: position.courierId,
          courierName: position.courierName,
          orderCount: position.orderCount,
          outstanding: { amount: position.outstandingAmount.toString(), currency: 'IRR' as const },
        })),
        meta: adminResponseMeta(),
      })
    } catch (error) {
      return cashFailure(request, reply, error)
    }
  })

  /**
   * How every bakery branch is doing on the bread it bakes.
   *
   * Read-only and behind the reporting permission: this is something an
   * operator looks at, and the flag it carries is an invitation to go and look
   * at a bakery rather than an action taken against one.
   */
  app.get('/api/v1/admin/quality/branches', CASH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      ADMIN_PERMISSIONS.reportsRead,
    )
    if (!actor) return reply

    try {
      const rows = await dependencies.engagement.branchQualityReport(
        actor.tenantId,
        dependencies.now?.() ?? new Date(),
      )
      return reply.send({
        success: true,
        data: rows.map((row) => ({
          bakeryBranchId: row.bakeryBranchId,
          branchNameFa: row.branchNameFa,
          bakeryNameFa: row.bakeryNameFa,
          qualityStatus: row.qualityStatus,
          sampleSize: row.signal.sampleSize,
          averageHundredths: row.signal.averageHundredths,
          flagForReview: row.signal.flagForReview,
        })),
        meta: adminResponseMeta(),
      })
    } catch (error) {
      return cashFailure(request, reply, error)
    }
  })

  /**
   * The orders one courier is still carrying cash for.
   *
   * What somebody at a desk with a bag of notes actually needs: the orders to
   * count against, named and priced, so the sum they type has something to be
   * checked against.
   */
  app.get<{ Params: { courierId: string } }>(
    '/api/v1/admin/cash/couriers/:courierId/orders',
    CASH_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(
        request,
        reply,
        dependencies,
        ADMIN_PERMISSIONS.ordersManage,
      )
      if (!actor) return reply

      try {
        const orders = await dependencies.service.outstandingOrdersFor(
          actor.tenantId,
          request.params.courierId,
        )
        return reply.send({
          success: true,
          data: orders.map((order) => ({
            orderId: order.orderId,
            publicId: order.publicId,
            amount: { amount: order.amount.toString(), currency: 'IRR' as const },
            collectedAt: order.collectedAt,
          })),
          meta: adminResponseMeta(),
        })
      } catch (error) {
        return cashFailure(request, reply, error)
      }
    },
  )

  /**
   * A courier hands the cash in.
   *
   * The amount is checked against what the named orders actually say, and
   * nothing is posted unless the two agree. A courier who is short has a
   * dispute, which is a conversation and a decision a person records — not a
   * rounding the ledger quietly absorbs.
   */
  app.post('/api/v1/admin/cash/remittances', CASH_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(
      request,
      reply,
      dependencies,
      ADMIN_PERMISSIONS.ordersManage,
    )
    if (!actor) return reply
    const parsed = cashRemittanceCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('INVALID_REMITTANCE', 'The remittance is invalid.'))
    }

    try {
      const result = await dependencies.service.recordRemittance(
        actor.tenantId,
        {
          courierId: parsed.data.courierId,
          orderIds: parsed.data.orderIds,
          declaredAmount: BigInt(parsed.data.declaredAmount),
          // Taken from the session, never from the body. A remittance is
          // signed for by whoever counted it, and a form that could name
          // someone else would make the signature worthless.
          countedById: actor.accountId,
          idempotencyKey: parsed.data.idempotencyKey,
        },
        dependencies.now?.() ?? new Date(),
        randomUUID(),
      )
      return reply.code(201).send({
        success: true,
        data: {
          remittanceId: result.remittanceId,
          courierId: result.courierId,
          orderCount: result.orderCount,
          expected: { amount: result.expectedAmount.toString(), currency: 'IRR' as const },
          declared: { amount: result.declaredAmount.toString(), currency: 'IRR' as const },
        },
        meta: adminResponseMeta(),
      })
    } catch (error) {
      return cashFailure(request, reply, error)
    }
  })
}

const CASH_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_NOT_FOUND: 'No such order.',
  CASH_PAYMENT_MISSING: 'That order has no payment to collect against.',
  REMITTANCE_EMPTY: 'A remittance has to settle at least one order.',
  REMITTANCE_ORDER_NOT_COLLECTIBLE:
    'One of those orders is not a collected cash order, or has already been handed in.',
  REMITTANCE_COURIER_MISMATCH: 'One of those orders was carried by a different courier.',
  REMITTANCE_DOES_NOT_BALANCE:
    'The amount counted does not match what those orders come to. Recount, or settle a different set.',
  IDEMPOTENCY_KEY_CONFLICT: 'That remittance key has already been used for a different courier.',
  INVALID_IDEMPOTENCY_KEY: 'The remittance key is invalid.',
  LEDGER_ACCOUNT_NOT_FOUND: 'The cash accounts are not provisioned for this tenant.',
  CASH_CONCURRENCY_CONFLICT: 'Somebody else was counting at the same moment. Try again.',
}

function cashFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CashOnDeliveryError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, CASH_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  request.log.error({ err: error }, 'cash desk failed')
  return reply.code(500).send(errorEnvelope('CASH_UNAVAILABLE', 'The cash desk is unavailable.'))
}
