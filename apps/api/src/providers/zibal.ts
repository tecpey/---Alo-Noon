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
 * Zibal (زیبال) REST v1, verified against two independent open-source drivers —
 * shetabit/multipay and parsisolution/gateway — which agree on every field used
 * here. Where they differ at all is in how strictly they read the reply, and
 * this adapter takes the stricter reading of the two.
 *
 * The contract is the plainest of the four gateways integrated here:
 *
 *     POST https://gateway.zibal.ir/v1/request   { merchant, amount, callbackUrl, orderId }
 *          → { result: 100, trackId }
 *     GET  https://gateway.zibal.ir/start/<trackId>
 *     POST https://gateway.zibal.ir/v1/verify    { merchant, trackId }
 *          → { result: 100, amount, orderId, refNumber, ... }
 *
 * Amounts are Rial: multipay multiplies by ten only when the application stores
 * Toman, and parsisolution calls `getRiyal()` outright. This system stores Rial,
 * so nothing is converted.
 *
 * Two properties make it easier to settle safely than Zarinpal, which has to be
 * told the amount and asked to agree:
 *
 * **Verify reports what was actually taken.** `amount` comes back in the reply,
 * so the settled amount is read from the gateway rather than asserted by us, and
 * the caller compares it against the order itself. That is the shape every
 * adapter here prefers.
 *
 * **Verify echoes the order.** Zibal keeps the `orderId` sent at request time
 * and returns it, so a reply about a different payment can be caught here rather
 * than being reconciled downstream. `orderId` is the payment attempt id, which
 * is what makes that check meaningful.
 *
 * There is no separate sandbox host — one set of endpoints serves both
 * environments — so `endpointOrigin` exists for the same reason it does on the
 * Zarinpal adapter: a network that cannot reach the gateway can still run the
 * money path against a stand-in.
 */
const PRODUCTION_ORIGIN = 'https://gateway.zibal.ir'

/** Shown in Zibal's own reports. Zibal accepts a request without one. */
const DEFAULT_DESCRIPTION = 'پرداخت سفارش'

/**
 * `result` values that a retry cannot change: the merchant, the callback URL, or
 * the amount is wrong. Everything unlisted stays retryable, which is this
 * codebase's standing default for a provider answer it cannot classify.
 */
const PERMANENT_REQUEST_RESULTS: ReadonlySet<number> = new Set([
  102, // merchant not found
  103, // merchant inactive
  104, // merchant invalid
  105, // amount below Zibal's 1,000 Rial minimum
  106, // callbackUrl invalid (must start with http or https)
  113, // amount above the terminal's ceiling
  114, // national code invalid
])

const VERIFY_OUTCOMES: ReadonlyMap<number, ProviderNormalizedOutcome> = new Map([
  [100, 'VERIFIED'],
  // Zibal's "already verified". What makes a repeated verify a replay rather
  // than a second capture.
  [201, 'VERIFIED'],
  [202, 'REJECTED'], // the order was never paid, or the payment failed
  [203, 'REJECTED'], // trackId invalid — it will never become valid
])

interface ZibalCredential extends Record<string, unknown> {
  merchant: string
}

function isZibalCredential(value: Record<string, unknown>): value is ZibalCredential {
  return typeof value['merchant'] === 'string' && value['merchant'].length > 0
}

/** Zibal's own reference. Both drivers send it as a JSON number, so it must be one. */
const TRACK_ID = /^\d{1,15}$/

export interface CreateZibalAdapterOptions {
  callbackUrl: string
  description?: string
  testOnly?: boolean
  /**
   * Overrides the gateway origin, keeping Zibal's own paths. Set from
   * `PAYMENT_ZIBAL_ENDPOINT`.
   */
  endpointOrigin?: string
}

export function createZibalAdapter(options: CreateZibalAdapterOptions): PaymentProviderAdapter {
  const origin = (options.endpointOrigin ?? PRODUCTION_ORIGIN).replace(/\/+$/, '')
  const requestUrl = `${origin}/v1/request`
  const verifyUrl = `${origin}/v1/verify`
  const startUrl = `${origin}/start/`
  const description = options.description ?? DEFAULT_DESCRIPTION

  return {
    code: 'ZIBAL',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set<PaymentProviderCapability>([
      'PAYMENT_INITIALIZATION',
      'CALLBACK_VERIFICATION',
    ]),
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome {
      const result = Number.parseInt(providerStatus, 10)
      if (Number.isNaN(result)) return 'FAILED'
      return VERIFY_OUTCOMES.get(result) ?? 'FAILED'
    },

    async initializePayment(
      request: ProviderPaymentRequest,
    ): Promise<ProviderInitializationResult> {
      let credential: ZibalCredential
      try {
        credential = parseJsonCredential(request.credential.material, isZibalCredential)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'ZIBAL_CREDENTIAL_INVALID',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      // JSON has no bigint and `Number` rounds silently past 2^53. An amount
      // that cannot round-trip is refused rather than sent approximately.
      if (request.amount <= 0n || request.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'ZIBAL_AMOUNT_UNSUPPORTED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            merchant: credential.merchant,
            amount: Number(request.amount),
            callbackUrl: options.callbackUrl,
            description,
            // Kept so verify can be checked against the payment it belongs to.
            orderId: request.paymentAttemptId,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          result?: unknown
          trackId?: unknown
        } | null
        const result = numeric(body?.result)
        const trackId = numeric(body?.trackId)

        if (response.status !== 200 || result !== 100 || trackId === null) {
          return {
            outcome:
              result !== null && PERMANENT_REQUEST_RESULTS.has(result)
                ? 'PERMANENT_FAILURE'
                : 'RETRYABLE_FAILURE',
            normalizedCode: `ZIBAL_REQUEST_${codeSuffix(result ?? response.status)}`,
            customerMessageKey: 'payment.initialization_unavailable',
          }
        }

        return {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: String(trackId),
          customerActionUrl: `${startUrl}${trackId}`,
        }
      } catch {
        return {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'ZIBAL_REQUEST_FAILED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    async verifyCallback(input: ProviderVerificationInput): Promise<ProviderVerificationResult> {
      if (!input.providerReference || !TRACK_ID.test(input.providerReference)) {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZIBAL_REFERENCE_MISSING',
        }
      }
      let credential: ZibalCredential
      try {
        credential = parseJsonCredential(input.credential.material, isZibalCredential)
      } catch {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZIBAL_CREDENTIAL_INVALID',
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
      try {
        const response = await fetch(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            merchant: credential.merchant,
            trackId: Number(input.providerReference),
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as {
          result?: unknown
          status?: unknown
          amount?: string | number
          orderId?: unknown
          refNumber?: unknown
        } | null
        const result = numeric(body?.result)

        if (response.status !== 200 || result === null) {
          return {
            verified: false,
            normalizedOutcome: 'FAILED',
            reasonCode: `ZIBAL_VERIFY_HTTP_${response.status}`,
          }
        }

        const outcome = this.mapProviderStatus(String(result))
        if (outcome !== 'VERIFIED') {
          // On 202 the reply also carries `status`, which says whether the
          // customer cancelled, the card was declined, or the payment simply
          // never happened. Keeping it is the difference between "declined" and
          // a support conversation that starts from nothing.
          const status = numeric(body?.status)
          return {
            verified: false,
            normalizedOutcome: outcome,
            reasonCode:
              status === null
                ? `ZIBAL_VERIFY_${codeSuffix(result)}`
                : `ZIBAL_VERIFY_${codeSuffix(result)}_STATUS_${codeSuffix(status)}`,
          }
        }

        // Zibal echoes the orderId sent at request time. A reply about a
        // different payment is never settled against this one, whatever it says.
        if (
          input.paymentAttemptId !== undefined &&
          typeof body?.orderId === 'string' &&
          body.orderId !== input.paymentAttemptId
        ) {
          return {
            verified: false,
            normalizedOutcome: 'FAILED',
            reasonCode: 'ZIBAL_VERIFY_ORDER_MISMATCH',
          }
        }

        // Read, not assumed. An unreadable amount leaves settledAmount absent,
        // which the settlement rule treats as unverifiable rather than as
        // agreement.
        const settledAmount = parseRialAmount(body?.amount)
        return {
          verified: true,
          normalizedOutcome: 'VERIFIED',
          providerReference: input.providerReference,
          ...(typeof body?.refNumber === 'string' || typeof body?.refNumber === 'number'
            ? { externalEventId: String(body.refNumber) }
            : {}),
          alreadySettled: result === 201,
          ...(settledAmount !== null && { settledAmount }),
        }
      } catch {
        return { verified: false, normalizedOutcome: 'FAILED', reasonCode: 'ZIBAL_VERIFY_FAILED' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts), so
// a minus sign becomes a readable NEG prefix rather than being stripped into an
// ambiguous digit. Zibal's `result` values are positive, but its transaction
// `status` values are not.
function codeSuffix(code: number): string {
  return code < 0 ? `NEG_${-code}` : String(code)
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  return null
}
