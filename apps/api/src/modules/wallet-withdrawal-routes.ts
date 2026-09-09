import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  walletWithdrawalCreateSchema,
  walletWithdrawalPayCommandSchema,
  walletWithdrawalRejectCommandSchema,
  type ErrorEnvelope,
  type ResponseMeta,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import type { AuthDependencies } from './auth.js'
import { authenticatedCustomer } from './commerce.js'
import { WalletWithdrawalError, type WalletWithdrawalService } from './wallet-withdrawal.js'

/**
 * Asking for a balance back, and the desk that answers.
 *
 * Two surfaces on one service. The customer's half needs a session and nothing
 * else — it is their own money. The staff half needs `admin.finance.settle`,
 * the same permission that pays partners, because it is the same act: money
 * leaving the platform's bank on somebody's say-so.
 *
 * Nothing here moves money at a bank. A person does that by hand and comes back
 * to record what the bank called it, exactly as with a partner payout. A
 * withdrawal desk that could make transfers on a session cookie would be the
 * most attractive thing in this system to steal.
 */
const SETTLE_PERMISSION = ADMIN_PERMISSIONS.financeSettle

// A person asks for their money back rarely and deliberately. Tight enough that
// a stolen session cannot enumerate anything, wide enough that a customer who
// mistypes a card number twice is not locked out.
const CUSTOMER_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }
const STAFF_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export interface WalletWithdrawalDependencies extends AdminAuthDependencies {
  service: WalletWithdrawalService
  auth: AuthDependencies
}

export function registerWalletWithdrawalRoutes(
  app: FastifyInstance,
  dependencies: WalletWithdrawalDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  app.post('/api/v1/wallet/withdrawals', CUSTOMER_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)

    const parsed = walletWithdrawalCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope('INVALID_WITHDRAWAL', 'اطلاعات برداشت کامل یا معتبر نیست.'))
    }

    try {
      const result = await dependencies.service.request(
        customer.tenantId,
        customer.customerId,
        {
          amount: BigInt(parsed.data.amount),
          cardNumber: parsed.data.cardNumber,
          cardHolderName: parsed.data.cardHolderName,
          ...(parsed.data.iban && { iban: parsed.data.iban }),
          idempotencyKey: parsed.data.idempotencyKey,
        },
        currentTime(),
        randomUUID(),
      )
      // A balance that will not cover it is an answer, not a fault: 422 with
      // the shortfall in words the customer can act on.
      if (!result.ok) return reply.code(422).send(envelope(result.code, result.message))
      return reply.code(201).send({ success: true, data: result.withdrawal, meta: meta() })
    } catch (error) {
      return customerFailure(request, reply, error)
    }
  })

  app.get('/api/v1/wallet/withdrawals', CUSTOMER_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) return unauthorized(reply)
    try {
      const withdrawals = await dependencies.service.listForCustomer(
        customer.tenantId,
        customer.customerId,
        20,
      )
      return reply.send({ success: true, data: withdrawals, meta: meta() })
    } catch (error) {
      return customerFailure(request, reply, error)
    }
  })

  app.get('/api/v1/admin/withdrawals', STAFF_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, SETTLE_PERMISSION)
    if (!actor) return reply
    try {
      const withdrawals = await dependencies.service.listOpen(actor.tenantId, 100)
      return reply.send({ success: true, data: withdrawals, meta: adminResponseMeta() })
    } catch (error) {
      return staffFailure(request, reply, error)
    }
  })

  app.post<{ Params: { withdrawalId: string } }>(
    '/api/v1/admin/withdrawals/:withdrawalId/paid',
    STAFF_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, SETTLE_PERMISSION)
      if (!actor) return reply
      const parsed = walletWithdrawalPayCommandSchema.safeParse(request.body)
      if (!parsed.success) return staffInvalid(reply, 'INVALID_BANK_REFERENCE')

      try {
        const withdrawal = await dependencies.service.markPaid(
          actor.tenantId,
          actor.accountId,
          {
            withdrawalId: request.params.withdrawalId,
            bankReference: parsed.data.bankReference,
          },
          currentTime(),
        )
        return reply.send({ success: true, data: withdrawal, meta: adminResponseMeta() })
      } catch (error) {
        return staffFailure(request, reply, error)
      }
    },
  )

  app.post<{ Params: { withdrawalId: string } }>(
    '/api/v1/admin/withdrawals/:withdrawalId/reject',
    STAFF_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, SETTLE_PERMISSION)
      if (!actor) return reply
      const parsed = walletWithdrawalRejectCommandSchema.safeParse(request.body)
      if (!parsed.success) return staffInvalid(reply, 'INVALID_REJECTION_REASON')

      try {
        const withdrawal = await dependencies.service.reject(
          actor.tenantId,
          actor.accountId,
          { withdrawalId: request.params.withdrawalId, reason: parsed.data.reason },
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: withdrawal, meta: adminResponseMeta() })
      } catch (error) {
        return staffFailure(request, reply, error)
      }
    },
  )
}

/** Persian for the customer's half; the panel's half speaks English like the rest. */
const CUSTOMER_MESSAGES: Readonly<Record<string, string>> = {
  WITHDRAWAL_NOT_FOUND: 'چنین درخواست برداشتی وجود ندارد.',
  WITHDRAWAL_ALREADY_SETTLED: 'این درخواست قبلاً بررسی شده است.',
}

const STAFF_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_BANK_REFERENCE: 'Record the reference the bank gave the transfer.',
  INVALID_REJECTION_REASON: 'Say why it was refused; the customer reads this.',
  WITHDRAWAL_FORBIDDEN: 'This account may not settle customer withdrawals.',
  WITHDRAWAL_NOT_FOUND: 'No such withdrawal request.',
  WITHDRAWAL_ALREADY_SETTLED: 'That request has already been answered.',
}

function staffInvalid(reply: FastifyReply, code: string): FastifyReply {
  return reply.code(400).send(errorEnvelope(code, STAFF_MESSAGES[code] ?? 'Invalid request.'))
}

function customerFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof WalletWithdrawalError) {
    return reply
      .code(error.status)
      .send(envelope(error.code, CUSTOMER_MESSAGES[error.code] ?? 'درخواست برداشت انجام نشد.'))
  }
  request.log.error({ err: error }, 'wallet withdrawal request failed')
  return reply.code(503).send(envelope('WITHDRAWAL_UNAVAILABLE', 'برداشت موقتاً در دسترس نیست.'))
}

function staffFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof WalletWithdrawalError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, STAFF_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('WITHDRAWAL_NOT_FOUND', 'No such withdrawal.'))
  }
  request.log.error({ err: error }, 'wallet withdrawal settlement failed')
  return reply
    .code(503)
    .send(errorEnvelope('WITHDRAWAL_UNAVAILABLE', 'The withdrawal desk is unavailable.'))
}

function meta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function envelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: meta() }
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send(envelope('SESSION_REQUIRED', 'ابتدا وارد شوید.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
