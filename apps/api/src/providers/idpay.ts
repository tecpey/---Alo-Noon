import type {
  PaymentProviderAdapter,
  PaymentProviderCapability,
  ProviderInitializationResult,
  ProviderNormalizedOutcome,
  ProviderPaymentRequest,
  ProviderVerificationInput,
  ProviderVerificationResult,
} from '@alo-noon/domain'

import { parseRialAmount } from './amounts.js'
import { parseJsonCredential } from './credential.js'

/**
 * IDPay (آی‌دی‌پی) REST integration, verified against the IDPay driver in the
 * open-source parsisolution/gateway library (api.idpay.ir/v1.1/payment).
 * Amount is Rial (its driver calls Amount::getRiyal()) — no conversion, and
 * the redirect is a plain GET link, unlike SizPay's POST-form requirement.
 *
 * Settlement is a server-to-server POST to .../verify keyed by the transaction
 * id IDPay issued at initialization. That call is what actually finalizes the
 * payment at IDPay; until it succeeds the money is not ours, which is why the
 * customer's redirect alone is never treated as payment.
 */
const BASE_URL = 'https://api.idpay.ir/v1.1/payment'
const VERIFY_URL = `${BASE_URL}/verify`

// https://idpay.ir docs, mirrored in parsisolution/gateway's getStatusMessage().
const STATUS_OUTCOMES: Readonly<Record<number, ProviderNormalizedOutcome>> = Object.freeze({
  1: 'FAILED',
  2: 'FAILED',
  3: 'FAILED',
  4: 'FAILED',
  5: 'FAILED',
  6: 'FAILED',
  7: 'REJECTED',
  8: 'CUSTOMER_ACTION_REQUIRED',
  10: 'PENDING',
  100: 'VERIFIED',
  101: 'VERIFIED',
  200: 'VERIFIED',
})

interface IdPayCredential extends Record<string, unknown> {
  apiKey: string
}

function isIdPayCredential(value: Record<string, unknown>): value is IdPayCredential {
  return typeof value['apiKey'] === 'string' && value['apiKey'].length > 0
}

export interface CreateIdPayAdapterOptions {
  callbackUrl: string
  testOnly?: boolean
}

export function createIdPayAdapter(options: CreateIdPayAdapterOptions): PaymentProviderAdapter {
  return {
    code: 'IDPAY',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set<PaymentProviderCapability>([
      'PAYMENT_INITIALIZATION',
      'CALLBACK_VERIFICATION',
    ]),
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome {
      const code = Number.parseInt(providerStatus, 10)
      return STATUS_OUTCOMES[code] ?? 'FAILED'
    },

    async initializePayment(
      request: ProviderPaymentRequest,
    ): Promise<ProviderInitializationResult> {
      let credential: IdPayCredential
      try {
        credential = parseJsonCredential(request.credential.material, isIdPayCredential)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'IDPAY_CREDENTIAL_INVALID',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(BASE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': credential.apiKey,
            'X-SANDBOX': request.configuration.environment === 'PRODUCTION' ? 'false' : 'true',
          },
          body: JSON.stringify({
            order_id: request.paymentAttemptId,
            amount: request.amount.toString(),
            callback: options.callbackUrl,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          id?: string
          link?: string
          error_code?: number | string
        } | null

        if (response.status !== 201 || !body?.id || !body.link) {
          return {
            outcome: 'RETRYABLE_FAILURE',
            normalizedCode: idPayFailureCode(body?.error_code, response.status),
            customerMessageKey: 'payment.initialization_unavailable',
          }
        }

        return {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: body.id,
          customerActionUrl: body.link,
        }
      } catch {
        return {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'IDPAY_REQUEST_FAILED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    async verifyCallback(input: ProviderVerificationInput): Promise<ProviderVerificationResult> {
      if (!input.providerReference || !input.paymentAttemptId) {
        // Without IDPay's own transaction id there is nothing to verify. Saying
        // so as an unverified FAILED keeps the caller retrying rather than
        // treating the absence as a rejection.
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'IDPAY_REFERENCE_MISSING',
        }
      }
      let credential: IdPayCredential
      try {
        credential = parseJsonCredential(input.credential.material, isIdPayCredential)
      } catch {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'IDPAY_CREDENTIAL_INVALID',
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
      try {
        const response = await fetch(VERIFY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': credential.apiKey,
            'X-SANDBOX': input.configuration.environment === 'PRODUCTION' ? 'false' : 'true',
          },
          // order_id is the attempt id we sent at initialization; IDPay checks
          // the pair, so a reference belonging to another order fails here.
          body: JSON.stringify({ id: input.providerReference, order_id: input.paymentAttemptId }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          status?: number
          track_id?: string | number
          amount?: string | number
          id?: string
        } | null

        if (response.status !== 200 || body?.status === undefined) {
          return {
            verified: false,
            normalizedOutcome: 'FAILED',
            reasonCode: `IDPAY_VERIFY_HTTP_${response.status}`,
          }
        }

        const outcome = this.mapProviderStatus(String(body.status))
        if (outcome !== 'VERIFIED' || !body.track_id) {
          return {
            verified: false,
            normalizedOutcome: outcome,
            reasonCode: `IDPAY_VERIFY_STATUS_${body.status}`,
          }
        }

        // IDPay reports Rial, the same unit the payment is stored in. Reporting
        // no usable amount leaves settledAmount absent, which the settlement
        // rule treats as unverifiable rather than as agreement.
        const settledAmount = parseRialAmount(body.amount)
        return {
          verified: true,
          normalizedOutcome: 'VERIFIED',
          providerReference: body.id ?? input.providerReference,
          externalEventId: String(body.track_id),
          // 101 is IDPay's "already verified", which is what makes a retried
          // verify safe rather than a double capture.
          alreadySettled: body.status === 101 || body.status === 200,
          ...(settledAmount !== null && { settledAmount }),
        }
      } catch {
        return { verified: false, normalizedOutcome: 'FAILED', reasonCode: 'IDPAY_VERIFY_FAILED' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts).
function idPayFailureCode(errorCode: number | string | undefined, httpStatus: number): string {
  const raw = errorCode !== undefined ? String(errorCode) : String(httpStatus)
  const safe = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'UNKNOWN'
  return `IDPAY_TOKEN_${safe}`
}
