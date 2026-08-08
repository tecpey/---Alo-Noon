import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  paymentCheckoutStartSchema,
  type ErrorEnvelope,
  type ResponseMeta,
} from '@alo-noon/contracts'

import type { AuthDependencies } from './auth.js'
import { authenticatedCustomer } from './commerce.js'
import { PaymentLedgerError, type PaymentLedgerService } from './payment-ledger.js'

/**
 * The customer's half of the payment cycle.
 *
 * Everything between a placed order and a captured payment already existed —
 * initialization, the gateway hand-off, callback intake, settlement, capture —
 * but nothing let a customer *start* it. An order was placed and then sat there,
 * because the `Payment` aggregate the rest of the pipeline hangs from could only
 * be created from a test fixture.
 *
 * Two routes close that gap:
 *
 * - `POST /api/v1/payments` opens the payment for an order the caller owns.
 * - `GET /api/v1/payments/:paymentId` reads it back, which is what the screen
 *   the gateway returns to needs. The return redirect proves nothing on its own
 *   — settlement decides, from the gateway's own answer — so the app asks the
 *   API rather than believing the URL it was sent to.
 *
 * Nothing here transitions the payment beyond CREATED. Settlement walks it to
 * PENDING, AUTHORIZED and captured when the gateway confirms, and letting a
 * customer request any of those would be letting them assert they had paid.
 */
export interface PaymentCheckoutDependencies {
  service: PaymentLedgerService
  auth: AuthDependencies
  now?: () => Date
}

export function registerPaymentCheckoutRoutes(
  app: FastifyInstance,
  dependencies: PaymentCheckoutDependencies,
): void {
  // A payment per order, so this is opened once per checkout. Anything faster
  // than this is a retry loop, not a customer.
  const CHECKOUT_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

  app.post('/api/v1/payments', CHECKOUT_RATE_LIMIT, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const customer = await authenticatedCustomer(request, dependencies.auth)
    if (!customer) {
      return reply
        .code(401)
        .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
    }
    const parsed = paymentCheckoutStartSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_PAYMENT_CHECKOUT_REQUEST', 'The request is invalid.'))
    }

    try {
      // ownership-established: the service resolves the order under this
      // session's customerId and refuses anything that is not theirs, so an
      // order id from the request body can only ever reach its owner's order.
      const payment = await dependencies.service.initialize(
        customer.tenantId,
        customer.customerId,
        { orderId: parsed.data.orderId, idempotencyKey: parsed.data.idempotencyKey },
        dependencies.now?.() ?? new Date(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: payment, meta: responseMeta() })
    } catch (error) {
      return checkoutFailure(request, reply, error)
    }
  })

  app.get<{ Params: { paymentId: string } }>(
    '/api/v1/payments/:paymentId',
    CHECKOUT_RATE_LIMIT,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const customer = await authenticatedCustomer(request, dependencies.auth)
      if (!customer) {
        return reply
          .code(401)
          .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid customer session is required.'))
      }

      try {
        // ownership-established: scoped to this session's customerId, so a
        // payment id guessed or copied from elsewhere reads as not found rather
        // than as someone else's payment.
        const payment = await dependencies.service.findForCustomer(
          customer.tenantId,
          customer.customerId,
          request.params.paymentId,
        )
        if (!payment) {
          return reply.code(404).send(errorEnvelope('PAYMENT_NOT_FOUND', 'No such payment.'))
        }
        return reply.send({ success: true, data: payment, meta: responseMeta() })
      } catch (error) {
        return checkoutFailure(request, reply, error)
      }
    },
  )
}

/**
 * Refusals a customer can act on, and their status.
 *
 * `PAYMENT_ALREADY_EXISTS` is a 409 rather than an error page: a customer who
 * double-tapped already has a payment, and the app's next step is to read it
 * back and carry on to the gateway.
 */
const CHECKOUT_STATUS: Readonly<Record<string, 404 | 409 | 422>> = {
  ORDER_NOT_FOUND: 404,
  PAYMENT_ALREADY_EXISTS: 409,
  ORDER_NOT_PAYABLE: 422,
  PAYMENT_VERSION_CONFLICT: 409,
}

const CHECKOUT_MESSAGES: Readonly<Record<string, string>> = {
  ORDER_NOT_FOUND: 'No such order.',
  PAYMENT_ALREADY_EXISTS: 'This order already has a payment.',
  ORDER_NOT_PAYABLE: 'This order cannot be paid in its current state.',
  PAYMENT_VERSION_CONFLICT: 'Another change landed first. Try again.',
}

function checkoutFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof PaymentLedgerError) {
    const status = CHECKOUT_STATUS[error.code]
    if (status) {
      return reply
        .code(status)
        .send(
          errorEnvelope(error.code, CHECKOUT_MESSAGES[error.code] ?? 'The request was refused.'),
        )
    }
  }
  // A malformed id reaches Postgres as a cast error rather than an empty
  // result, so it must not be reported as an outage.
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('PAYMENT_NOT_FOUND', 'No such payment.'))
  }
  request.log.error({ err: error }, 'Payment checkout failed')
  return reply
    .code(503)
    .send(errorEnvelope('PAYMENT_CHECKOUT_UNAVAILABLE', 'Payments are temporarily unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}

function responseMeta(): ResponseMeta {
  return { requestId: randomUUID(), timestamp: new Date().toISOString(), version: 'v1' }
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: responseMeta() }
}
