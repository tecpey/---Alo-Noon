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
 * Shepa (شپا) REST integration, verified against the Shepa driver in the
 * open-source parsisolution/gateway library (merchant.shepa.com/api/v1/token
 * and /verify). Shepa's own docs are hosted under a path literally named
 * "rial-gateway", and its driver never converts the amount before sending it,
 * so amounts are IRR (Rial) — no conversion needed, unlike NextPay's Toman API.
 * Shepa's error codes are not publicly enumerated anywhere found during
 * research, so every rejected/invalid response defaults to RETRYABLE_FAILURE
 * (the same conservative default used elsewhere in this codebase for
 * unclassified provider errors) rather than guessing which codes are
 * permanent.
 *
 * Settlement is a server-to-server POST to /verify carrying the token and the
 * amount. Shepa's driver reads the amount back out of the response, which is
 * what the caller compares against the payment; Shepa publishes no distinct
 * "already verified" code, so a repeat verify is reported as an ordinary
 * success and idempotency rests on the caller's own keys.
 */
const PRODUCTION_URL = 'https://merchant.shepa.com/api/v1/'
const SANDBOX_URL = 'https://sandbox.shepa.com/api/v1/'

interface ShepaCredential extends Record<string, unknown> {
  apiKey: string
}

function isShepaCredential(value: Record<string, unknown>): value is ShepaCredential {
  return typeof value['apiKey'] === 'string' && value['apiKey'].length > 0
}

interface ShepaTokenResult {
  token: string
  url: string
}

function isShepaTokenResult(value: unknown): value is ShepaTokenResult {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['token'] === 'string' &&
    typeof (value as Record<string, unknown>)['url'] === 'string'
  )
}

export interface CreateShepaAdapterOptions {
  callbackUrl: string
  testOnly?: boolean
}

export function createShepaAdapter(options: CreateShepaAdapterOptions): PaymentProviderAdapter {
  return {
    code: 'SHEPA',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set<PaymentProviderCapability>([
      'PAYMENT_INITIALIZATION',
      'CALLBACK_VERIFICATION',
    ]),
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome {
      if (providerStatus === 'success') return 'VERIFIED'
      return 'FAILED'
    },

    async initializePayment(
      request: ProviderPaymentRequest,
    ): Promise<ProviderInitializationResult> {
      let credential: ShepaCredential
      try {
        credential = parseJsonCredential(request.credential.material, isShepaCredential)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'SHEPA_CREDENTIAL_INVALID',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const baseUrl =
        request.configuration.environment === 'PRODUCTION' ? PRODUCTION_URL : SANDBOX_URL

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(`${baseUrl}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            api: credential.apiKey,
            amount: request.amount.toString(),
            callback: options.callbackUrl,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          success?: boolean
          result?: unknown
          errorCode?: number | string
        } | null

        if (!response.ok || !body?.success || !isShepaTokenResult(body.result)) {
          return {
            outcome: 'RETRYABLE_FAILURE',
            normalizedCode: shepaFailureCode(body?.errorCode, response.status),
            customerMessageKey: 'payment.initialization_unavailable',
          }
        }

        return {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: body.result.token,
          customerActionUrl: body.result.url,
        }
      } catch {
        return {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'SHEPA_REQUEST_FAILED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    async verifyCallback(input: ProviderVerificationInput): Promise<ProviderVerificationResult> {
      if (!input.providerReference || input.expectedAmount === undefined) {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'SHEPA_REFERENCE_MISSING',
        }
      }
      let credential: ShepaCredential
      try {
        credential = parseJsonCredential(input.credential.material, isShepaCredential)
      } catch {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'SHEPA_CREDENTIAL_INVALID',
        }
      }

      const baseUrl =
        input.configuration.environment === 'PRODUCTION' ? PRODUCTION_URL : SANDBOX_URL
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
      try {
        const response = await fetch(`${baseUrl}verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            api: credential.apiKey,
            amount: input.expectedAmount.toString(),
            token: input.providerReference,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          success?: boolean
          result?: { refid?: string; transaction_id?: string; amount?: string | number }
          errorCode?: number | string
        } | null

        if (!response.ok || !body?.success || !body.result) {
          return {
            verified: false,
            normalizedOutcome: 'FAILED',
            reasonCode: shepaFailureCode(body?.errorCode, response.status).replace(
              'TOKEN',
              'VERIFY',
            ),
          }
        }

        const settledAmount = parseRialAmount(body.result.amount)
        return {
          verified: true,
          normalizedOutcome: 'VERIFIED',
          providerReference: input.providerReference,
          ...(body.result.refid && { externalEventId: String(body.result.refid) }),
          ...(settledAmount !== null && { settledAmount }),
        }
      } catch {
        return { verified: false, normalizedOutcome: 'FAILED', reasonCode: 'SHEPA_VERIFY_FAILED' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts).
function shepaFailureCode(errorCode: number | string | undefined, httpStatus: number): string {
  const raw = errorCode !== undefined ? String(errorCode) : String(httpStatus)
  const safe = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'UNKNOWN'
  return `SHEPA_TOKEN_${safe}`
}
