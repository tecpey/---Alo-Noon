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
import type { PaymentSettlementService } from './payment-settlement.js'

/**
 * Receives the gateway's browser redirect after a customer returns from
 * payment. Everything in the request is untrusted: the customer's browser (or
 * an attacker) controls every parameter, so this route must never conclude that
 * a payment succeeded, never mutate Payment or Order state, and never echo the
 * provider's claims back to the customer.
 *
 * It records the callback durably and idempotently, then asks the settlement
 * service to establish the truth by calling the gateway server-to-server. The
 * verdict never reaches the customer here: they are sent to a neutral result
 * page either way, because a redirect that announced success would be announcing
 * something this request has no standing to know.
 *
 * Settling inline is only the fastest trigger, never the guarantee. Anything it
 * misses — an unreachable gateway, a customer who closed the tab — is recovered
 * by the sweep over unprocessed receipts.
 */
export interface PaymentCallbackDependencies {
  providerService: PaymentProviderService
  auth: AuthDependencies
  resultRedirectUrl: string
  environment: 'TEST' | 'PRODUCTION'
  /**
   * Settles the recorded callback. Optional so the route still records receipts
   * in a deployment with no settlement configured; where it is present, the
   * customer's return is the fastest trigger available, and the recovery sweep
   * catches whatever this misses.
   */
  settlementService?: PaymentSettlementService
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

    let receiptId: string | null = null
    try {
      const receipt = await dependencies.providerService.receiveCallback(
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
      receiptId = receipt.id
    } catch (error) {
      // A failure to record must not strand the customer on an error page, and
      // must not imply anything about whether their payment went through.
      request.log.error({ err: error, providerCode }, 'Payment callback could not be recorded')
    }

    if (receiptId && dependencies.settlementService) {
      try {
        await dependencies.settlementService.settle(
          tenantId,
          { callbackReceiptId: receiptId },
          dependencies.now?.() ?? new Date(),
          randomUUID(),
        )
      } catch (error) {
        // Settling here is an optimisation, not the guarantee. An unreachable
        // gateway leaves the receipt unprocessed for the sweep, and the customer
        // still lands on a page that promises nothing either way.
        request.log.warn({ err: error, providerCode }, 'Payment callback settlement deferred')
      }
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
