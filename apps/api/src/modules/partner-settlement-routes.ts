import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  markPayoutPaidCommandSchema,
  payoutListQuerySchema,
  preparePayoutCommandSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { PartnerSettlementError, type PartnerSettlementService } from './partner-settlement.js'

/**
 * The payout desk.
 *
 * Four routes, and the ordering between them is the control: an operator reads
 * what is owed, prepares a run — which claims the earnings and posts the
 * liability discharge in one transaction — sends the money by hand at a bank,
 * and comes back to record what the bank called it. Nothing here initiates a
 * transfer; the platform does not hold banking credentials, and a payout desk
 * that could move money on a session cookie would be the single most attractive
 * thing in the system to steal.
 *
 * Reading balances is gated on the same permission as paying them. A list of
 * every partner's unpaid earnings is the payout run in all but the act, and
 * splitting a read permission off would only make the surface look finer-grained
 * than it is — `admin.reports.read` already answers "how is the business doing"
 * without naming who is owed what.
 */
const SETTLEMENT_PERMISSION = ADMIN_PERMISSIONS.financeSettle

// A payout run is a handful of deliberate acts by one person at a desk, not a
// loop. This bounds a stolen session to something an audit trail can be read
// through while never getting in a real operator's way.
const SETTLEMENT_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export interface PartnerSettlementDependencies extends AdminAuthDependencies {
  service: PartnerSettlementService
}

export function registerPartnerSettlementRoutes(
  app: FastifyInstance,
  dependencies: PartnerSettlementDependencies,
): void {
  const now = (): Date => dependencies.now?.() ?? new Date()

  app.get('/api/v1/admin/settlement/outstanding', SETTLEMENT_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, SETTLEMENT_PERMISSION)
    if (!actor) return reply
    try {
      const balances = await dependencies.service.listOutstanding(actor.tenantId)
      return reply.send({ success: true, data: balances, meta: adminResponseMeta() })
    } catch (error) {
      return settlementFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/settlement/payouts', SETTLEMENT_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, SETTLEMENT_PERMISSION)
    if (!actor) return reply
    const parsed = preparePayoutCommandSchema.safeParse(request.body)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_PAYOUT_COMMAND')

    try {
      const payout = await dependencies.service.preparePayout(
        actor.tenantId,
        actor.accountId,
        parsed.data,
        now(),
        randomUUID(),
      )
      // Nothing owing is not a failure, and it is not a payout either. 204
      // says so without inventing a zero-amount run the ledger would have to
      // carry forever.
      if (!payout) return reply.code(204).send()
      return reply.code(201).send({ success: true, data: payout, meta: adminResponseMeta() })
    } catch (error) {
      return settlementFailure(request, reply, error)
    }
  })

  app.post<{ Params: { payoutId: string } }>(
    '/api/v1/admin/settlement/payouts/:payoutId/paid',
    SETTLEMENT_RATE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, SETTLEMENT_PERMISSION)
      if (!actor) return reply
      const parsed = markPayoutPaidCommandSchema.safeParse(request.body)
      if (!parsed.success) return invalidCommand(reply, 'INVALID_BANK_REFERENCE')

      try {
        const payout = await dependencies.service.markPaid(
          actor.tenantId,
          actor.accountId,
          { payoutId: request.params.payoutId, bankReference: parsed.data.bankReference },
          now(),
        )
        return reply.send({ success: true, data: payout, meta: adminResponseMeta() })
      } catch (error) {
        return settlementFailure(request, reply, error)
      }
    },
  )

  app.get('/api/v1/admin/settlement/payouts', SETTLEMENT_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, SETTLEMENT_PERMISSION)
    if (!actor) return reply
    const parsed = payoutListQuerySchema.safeParse(request.query)
    if (!parsed.success) return invalidCommand(reply, 'INVALID_PAYOUT_QUERY')

    try {
      const payouts = await dependencies.service.listPayouts(actor.tenantId, parsed.data.limit)
      return reply.send({ success: true, data: payouts, meta: adminResponseMeta() })
    } catch (error) {
      return settlementFailure(request, reply, error)
    }
  })
}

function invalidCommand(reply: FastifyReply, code: string): FastifyReply {
  return reply.code(400).send(errorEnvelope(code, SETTLEMENT_MESSAGES[code] ?? 'Invalid request.'))
}

function settlementFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof PartnerSettlementError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, SETTLEMENT_MESSAGES[error.code] ?? 'The payout was refused.'))
  }
  // A malformed identifier in the path reaches Postgres as a cast error rather
  // than an empty result; reporting it as an outage would blame the server for
  // a bad link.
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('PAYOUT_NOT_FOUND', 'No such payout.'))
  }
  request.log.error({ err: error }, 'Partner settlement operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('SETTLEMENT_UNAVAILABLE', 'The payout desk is temporarily unavailable.'))
}

const SETTLEMENT_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_PAYOUT_COMMAND: 'Name the partner and the party being paid.',
  INVALID_PAYOUT_QUERY: 'That payout listing is not a valid request.',
  INVALID_BANK_REFERENCE: 'Record the reference the bank gave the transfer.',
  SETTLEMENT_FORBIDDEN: 'This account may not prepare or settle partner payouts.',
  PAYOUT_NOT_FOUND: 'No such payout.',
  PAYOUT_NOT_DRAFT: 'That payout is no longer awaiting payment.',
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
