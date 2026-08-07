import type {
  PaymentProviderAdapter,
  PaymentProviderCapability,
  ProviderInitializationResult,
  ProviderNormalizedOutcome,
  ProviderPaymentRequest,
} from '@alo-noon/domain'

import { parseJsonCredential } from './credential.js'

/**
 * IDPay (آی‌دی‌پی) REST integration, verified against the IDPay driver in the
 * open-source parsisolution/gateway library (api.idpay.ir/v1.1/payment).
 * Amount is Rial (its driver calls Amount::getRiyal()) — no conversion, and
 * the redirect is a plain GET link, unlike SizPay's POST-form requirement.
 * Only PAYMENT_INITIALIZATION is implemented — callback receipt verification
 * (POST .../verify) is a separate, not-yet-built HTTP surface (ADR-0010 phase 2).
 */
const BASE_URL = 'https://api.idpay.ir/v1.1/payment'

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
    capabilities: new Set<PaymentProviderCapability>(['PAYMENT_INITIALIZATION']),
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
  }
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts).
function idPayFailureCode(errorCode: number | string | undefined, httpStatus: number): string {
  const raw = errorCode !== undefined ? String(errorCode) : String(httpStatus)
  const safe = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'UNKNOWN'
  return `IDPAY_TOKEN_${safe}`
}
