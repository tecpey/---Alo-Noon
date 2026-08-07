import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  canonicalCallbackParams,
  extractExternalEventId,
  isCallbackProviderCode,
} from '../providers/callback-parsers.js'
import type { AuthDependencies } from './auth.js'
import { resolveTenantId } from './auth.js'
import type { PaymentProviderService } from './payment-provider.js'

/**
 * Receives the gateway's browser redirect after a customer returns from
 * payment. Everything in the request is untrusted: the customer's browser (or
 * an attacker) controls every parameter, so this route must never conclude that
 * a payment succeeded, never mutate Payment or Order state, and never echo the
 * provider's claims back to the customer.
 *
 * All it does is record the callback durably and idempotently, then send the
 * customer to a neutral result page. The authoritative outcome comes later from
 * server-to-server verification, which is deliberately not performed here (see
 * ADR-0010: verification, inquiry, and capture are a separate phase).
 */
export interface PaymentCallbackDependencies {
  providerService: PaymentProviderService
  auth: AuthDependencies
  resultRedirectUrl: string
  environment: 'TEST' | 'PRODUCTION'
  now?: () => Date
}

export function registerPaymentCallbackRoutes(
  app: FastifyInstance,
  dependencies: PaymentCallbackDependencies,
): void {
  const handler = async (
    request: FastifyRequest<{ Params: { providerCode: string } }>,
    reply: FastifyReply,
  ): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')

    // The gateway redirects the customer's browser here, so there is no session.
    // Tenant still comes from the verified host, never from a request parameter.
    const tenantId = await resolveTenantId(request, dependencies.auth)
    const providerCode = String(request.params.providerCode ?? '').toUpperCase()

    if (!tenantId || !isCallbackProviderCode(providerCode)) {
      return redirectToResult(reply, dependencies.resultRedirectUrl, null)
    }

    const params = canonicalCallbackParams([
      request.query as Record<string, unknown>,
      request.body as Record<string, unknown>,
    ])
    const externalEventId = extractExternalEventId(providerCode, params)
    if (!externalEventId) {
      request.log.warn({ providerCode }, 'Payment callback lacked a usable provider reference')
      return redirectToResult(reply, dependencies.resultRedirectUrl, null)
    }

    try {
      await dependencies.providerService.receiveCallback(
        tenantId,
        {
          providerCode,
          environment: dependencies.environment,
          externalEventId,
          // Iranian gateway redirects carry no signed provider headers; the
          // service only accepts an explicit allow-list, so send none.
          approvedHeaders: {},
          canonicalPayload: params,
          // Deterministic so a customer refreshing the return page, or the
          // gateway retrying, replays onto the same receipt instead of creating
          // duplicates.
          idempotencyKey: callbackIdempotencyKey(providerCode, externalEventId),
        },
        dependencies.now?.() ?? new Date(),
        randomUUID(),
      )
    } catch (error) {
      // A failure to record must not strand the customer on an error page, and
      // must not imply anything about whether their payment went through.
      request.log.error({ err: error, providerCode }, 'Payment callback could not be recorded')
    }

    return redirectToResult(reply, dependencies.resultRedirectUrl, externalEventId)
  }

  const routeOptions = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }
  app.get('/api/v1/payments/callback/:providerCode', routeOptions, handler)
  app.post('/api/v1/payments/callback/:providerCode', routeOptions, handler)
}

/**
 * Sends the customer to a neutral "we are checking your payment" page. The
 * reference is opaque and carries no verdict, so a forged callback cannot make
 * the app display a successful payment.
 */
function redirectToResult(
  reply: FastifyReply,
  resultRedirectUrl: string,
  reference: string | null,
): unknown {
  const target = new URL(resultRedirectUrl)
  if (reference) target.searchParams.set('reference', reference)
  return reply.redirect(target.toString(), 303)
}

export function callbackIdempotencyKey(providerCode: string, externalEventId: string): string {
  return createHash('sha256').update(`callback:${providerCode}:${externalEventId}`).digest('hex')
}
