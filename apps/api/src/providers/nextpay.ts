import type {
  PaymentProviderAdapter,
  PaymentProviderCapability,
  ProviderInitializationResult,
  ProviderNormalizedOutcome,
  ProviderPaymentRequest,
} from '@alo-noon/domain'

import { parseJsonCredential } from './credential.js'

/**
 * NextPay (نکست‌پی) REST integration, verified against the official
 * nextpay-ir/class-nextpay-payment-gateway repository (token.http/verify.http
 * flow, code -1 = token success, code 0 = verified). NextPay bills in Toman;
 * this codebase's money is integer IRR, so amounts must be a multiple of 10.
 * Only PAYMENT_INITIALIZATION is implemented here — callback receipt
 * verification is a separate, not-yet-built HTTP surface (ADR-0010 phase 2).
 */
const TOKEN_URL = 'https://api.nextpay.org/gateway/token.http'
const PAYMENT_URL = 'https://api.nextpay.org/gateway/payment'
const TOKEN_SUCCESS_CODE = -1
const VERIFY_SUCCESS_CODE = 0
const VERIFY_PENDING_CODE = -1

// https://github.com/nextpay-ir/class-nextpay-payment-gateway — codes that mean the
// request itself (credentials/amount/config) is wrong, not a transient failure.
const PERMANENT_TOKEN_CODES = new Set([-24, -27, -33, -35, -36, -39, -40, -43, -47, -73])

interface NextPayCredential extends Record<string, unknown> {
  apiKey: string
}

function isNextPayCredential(value: Record<string, unknown>): value is NextPayCredential {
  return typeof value['apiKey'] === 'string' && value['apiKey'].length > 0
}

function toToman(amountIrr: bigint): string {
  if (amountIrr <= 0n || amountIrr % 10n !== 0n) {
    throw new Error('AMOUNT_NOT_TOMAN_ALIGNED')
  }
  return (amountIrr / 10n).toString()
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts),
// so a negative provider code like -33 becomes NEXTPAY_TOKEN_NEG33.
function tokenFailureCode(code: number | undefined, httpStatus: number): string {
  const value = code ?? httpStatus
  return `NEXTPAY_TOKEN_${value < 0 ? `NEG${Math.abs(value)}` : String(value)}`
}

export interface CreateNextPayAdapterOptions {
  callbackUrl: string
  testOnly?: boolean
}

export function createNextPayAdapter(options: CreateNextPayAdapterOptions): PaymentProviderAdapter {
  return {
    code: 'NEXTPAY',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set<PaymentProviderCapability>(['PAYMENT_INITIALIZATION']),
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome {
      const code = Number.parseInt(providerStatus, 10)
      if (code === VERIFY_SUCCESS_CODE) return 'VERIFIED'
      if (code === VERIFY_PENDING_CODE) return 'PENDING'
      return 'FAILED'
    },

    async initializePayment(
      request: ProviderPaymentRequest,
    ): Promise<ProviderInitializationResult> {
      let credential: NextPayCredential
      try {
        credential = parseJsonCredential(request.credential.material, isNextPayCredential)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'NEXTPAY_CREDENTIAL_INVALID',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      let amount: string
      try {
        amount = toToman(request.amount)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'NEXTPAY_AMOUNT_NOT_TOMAN_ALIGNED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            api_key: credential.apiKey,
            order_id: request.paymentAttemptId,
            amount,
            callback_uri: options.callbackUrl,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          code?: number
          trans_id?: string
        } | null

        if (!response.ok || !body || body.code !== TOKEN_SUCCESS_CODE || !body.trans_id) {
          const code = body?.code
          return {
            outcome:
              code !== undefined && PERMANENT_TOKEN_CODES.has(code)
                ? 'PERMANENT_FAILURE'
                : 'RETRYABLE_FAILURE',
            normalizedCode: tokenFailureCode(code, response.status),
            customerMessageKey: 'payment.initialization_unavailable',
          }
        }

        return {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: body.trans_id,
          customerActionUrl: `${PAYMENT_URL}/${body.trans_id}`,
        }
      } catch {
        return {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'NEXTPAY_REQUEST_FAILED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
