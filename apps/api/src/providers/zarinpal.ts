import type {
  PaymentProviderAdapter,
  PaymentProviderCapability,
  ProviderInitializationResult,
  ProviderNormalizedOutcome,
  ProviderPaymentRequest,
  ProviderVerificationInput,
  ProviderVerificationResult,
} from '@alo-noon/domain'

import { parseJsonCredential } from './credential.js'

/**
 * Zarinpal (زرین‌پال) REST v4, verified against the Zarinpal driver and config in
 * the open-source shetabit/multipay library.
 *
 * Two properties of this gateway are worth stating up front, because they are
 * why this adapter exists and why it is shaped differently from the other three.
 *
 * **It has a sandbox.** `sandbox.zarinpal.com` speaks the same v4 contract on
 * the same paths as production, with no real money and no real card. That makes
 * `initialize → redirect → callback → verify → capture` runnable end to end
 * before a single Rial is at stake, which is not true of any other gateway
 * integrated here. `TEST` environments therefore point at the sandbox by
 * default rather than at production with a flag.
 *
 * **The verify response carries no amount.** Every other adapter here reads the
 * settled amount back out of the gateway's answer, because a confirmation that
 * merely repeats our own question proves nothing. Zarinpal answers a different
 * way: the amount is an *input* to verify, and the gateway compares it against
 * what the card was actually charged, refusing with code -50 when they differ.
 * So a 100/101 for an amount we sent is the gateway asserting equality with its
 * own record — evidence, not an echo — and it is the one case in this codebase
 * where reporting `settledAmount` from the expected amount is honest. It is
 * fenced accordingly: this adapter refuses to verify at all without an expected
 * amount, so the assertion can never be made vacuously.
 *
 * Refusing to verify is also how a mismatch is made safe. Zarinpal returns money
 * to the customer for a transaction that is never verified, so declining -50
 * (rather than capturing something we cannot reconcile) is the outcome that
 * leaves nobody out of pocket.
 */
interface ZarinpalEndpoints {
  readonly request: string
  readonly verify: string
  readonly startPay: string
}

const PRODUCTION_ENDPOINTS: ZarinpalEndpoints = Object.freeze({
  request: 'https://api.zarinpal.com/pg/v4/payment/request.json',
  verify: 'https://api.zarinpal.com/pg/v4/payment/verify.json',
  startPay: 'https://www.zarinpal.com/pg/StartPay/',
})
const SANDBOX_ENDPOINTS: ZarinpalEndpoints = Object.freeze({
  request: 'https://sandbox.zarinpal.com/pg/v4/payment/request.json',
  verify: 'https://sandbox.zarinpal.com/pg/v4/payment/verify.json',
  startPay: 'https://sandbox.zarinpal.com/pg/StartPay/',
})

/**
 * Amounts are IRR minor units on both sides: the multipay driver multiplies by
 * ten only when the *application* stores Toman, and sends `currency: 'IRR'`
 * explicitly. This system stores Rial, so nothing is converted — and the
 * currency is still sent explicitly, so a merchant panel configured for Toman
 * cannot reinterpret the number as ten times less money.
 */
const CURRENCY = 'IRR'

/** Shown to the customer on Zarinpal's page. Zarinpal requires a description. */
const DEFAULT_DESCRIPTION = 'پرداخت سفارش'

/**
 * Codes from the driver's own translation table. Only verified codes appear
 * here; anything unrecognised is treated as retryable, which is this codebase's
 * standing default for a provider answer it cannot classify.
 *
 * "Permanent" means retrying the same request cannot change the answer: our
 * merchant id, our terminal, our callback domain, or our request body is wrong.
 * -12 (too many attempts in a short window) is the one negative code here that
 * a later attempt genuinely can clear.
 */
const PERMANENT_INITIALIZATION_CODES: ReadonlySet<number> = new Set([
  -9, // validation error on the values we sent
  -10, // merchant id or IP not valid
  -11, // merchant not active
  -15, // terminal suspended
  -16, // merchant verification level too low
  -18, // callback domain differs from the registered one
  -30, // floating settlement not permitted
  -31, // no settlement bank account
  -32, // share values invalid
  -33, // share percentages invalid
  -34, // share amount exceeds the transaction
  -35, // too many share recipients
  -39, // wages error
  -40, // invalid extra parameters
])

const VERIFY_OUTCOMES: ReadonlyMap<number, ProviderNormalizedOutcome> = new Map([
  [100, 'VERIFIED'],
  // Already verified by an earlier call — what makes a replay safe rather than a
  // second capture.
  [101, 'VERIFIED'],
  // The amount paid differs from the amount verified. Terminal on purpose:
  // Zarinpal returns an unverified transaction to the customer, so declining is
  // the outcome that leaves nobody out of pocket.
  [-50, 'REJECTED'],
  [-51, 'REJECTED'], // payment unsuccessful
  [-54, 'REJECTED'], // authority invalid — it will never become valid
])

interface ZarinpalCredential extends Record<string, unknown> {
  merchantId: string
}

function isZarinpalCredential(value: Record<string, unknown>): value is ZarinpalCredential {
  return typeof value['merchantId'] === 'string' && value['merchantId'].length > 0
}

/**
 * Success puts an object in `data` and an empty array in `errors`; failure does
 * the reverse, putting an empty array in `data`. Reading either one therefore
 * has to survive finding an array where an object was expected.
 */
function objectField(body: unknown, field: 'data' | 'errors'): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>)[field]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numericCode(source: Record<string, unknown> | null): number | null {
  const raw = source?.['code']
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
  return null
}

export interface CreateZarinpalAdapterOptions {
  callbackUrl: string
  description?: string
  testOnly?: boolean
  /**
   * Overrides the gateway origin for both environments, keeping Zarinpal's own
   * paths. Set from `PAYMENT_ZARINPAL_ENDPOINT` so the money path can be driven
   * against a local stand-in when the real sandbox is unreachable — the same
   * seam `AUTH_SMS_LIMOSMS_ENDPOINT` provides for SMS.
   */
  endpointOrigin?: string
}

function endpointsFor(
  environment: 'TEST' | 'PRODUCTION',
  endpointOrigin: string | undefined,
): ZarinpalEndpoints {
  if (endpointOrigin !== undefined) {
    const base = endpointOrigin.replace(/\/+$/, '')
    return Object.freeze({
      request: `${base}/pg/v4/payment/request.json`,
      verify: `${base}/pg/v4/payment/verify.json`,
      startPay: `${base}/pg/StartPay/`,
    })
  }
  return environment === 'PRODUCTION' ? PRODUCTION_ENDPOINTS : SANDBOX_ENDPOINTS
}

/**
 * JSON has no bigint, and `Number` silently rounds past 2^53. An amount that
 * cannot round-trip is refused rather than sent approximately: an off-by-a-few
 * Rial request would be verified against a different number and fail at -50 with
 * nothing to explain it.
 */
function amountForRequest(amount: bigint): number | null {
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(amount)
}

export function createZarinpalAdapter(
  options: CreateZarinpalAdapterOptions,
): PaymentProviderAdapter {
  const description = options.description ?? DEFAULT_DESCRIPTION

  return {
    code: 'ZARINPAL',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set<PaymentProviderCapability>([
      'PAYMENT_INITIALIZATION',
      'CALLBACK_VERIFICATION',
    ]),
    ...(options.testOnly !== undefined && { testOnly: options.testOnly }),

    mapProviderStatus(providerStatus: string): ProviderNormalizedOutcome {
      const code = Number.parseInt(providerStatus, 10)
      if (Number.isNaN(code)) return 'FAILED'
      return VERIFY_OUTCOMES.get(code) ?? 'FAILED'
    },

    async initializePayment(
      request: ProviderPaymentRequest,
    ): Promise<ProviderInitializationResult> {
      let credential: ZarinpalCredential
      try {
        credential = parseJsonCredential(request.credential.material, isZarinpalCredential)
      } catch {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'ZARINPAL_CREDENTIAL_INVALID',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const amount = amountForRequest(request.amount)
      if (amount === null) {
        return {
          outcome: 'PERMANENT_FAILURE',
          normalizedCode: 'ZARINPAL_AMOUNT_UNSUPPORTED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      }

      const endpoints = endpointsFor(request.configuration.environment, options.endpointOrigin)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(endpoints.request, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            merchant_id: credential.merchantId,
            amount,
            currency: CURRENCY,
            callback_url: options.callbackUrl,
            description,
          }),
          signal: controller.signal,
        })
        // Zarinpal answers a rejected request with a non-2xx status carrying the
        // error body, so the status is never the decision — the body is.
        const body = (await response.json().catch(() => null)) as unknown
        const data = objectField(body, 'data')
        const authority = data?.['authority']

        if (numericCode(data) !== 100 || typeof authority !== 'string' || authority.length === 0) {
          const errorCode = numericCode(objectField(body, 'errors')) ?? numericCode(data)
          return {
            outcome:
              errorCode !== null && PERMANENT_INITIALIZATION_CODES.has(errorCode)
                ? 'PERMANENT_FAILURE'
                : 'RETRYABLE_FAILURE',
            normalizedCode: zarinpalCode('REQUEST', errorCode, response.status),
            customerMessageKey: 'payment.initialization_unavailable',
          }
        }

        return {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: authority,
          customerActionUrl: `${endpoints.startPay}${encodeURIComponent(authority)}`,
        }
      } catch {
        return {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'ZARINPAL_REQUEST_FAILED',
          customerMessageKey: 'payment.initialization_unavailable',
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    async verifyCallback(input: ProviderVerificationInput): Promise<ProviderVerificationResult> {
      // Both are required, and the amount is required for a reason beyond the
      // wire format: it is the whole basis on which this adapter is allowed to
      // report a settled amount at all. Without it there is nothing to assert.
      if (!input.providerReference || input.expectedAmount === undefined) {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZARINPAL_VERIFY_INPUT_MISSING',
        }
      }
      let credential: ZarinpalCredential
      try {
        credential = parseJsonCredential(input.credential.material, isZarinpalCredential)
      } catch {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZARINPAL_CREDENTIAL_INVALID',
        }
      }

      const amount = amountForRequest(input.expectedAmount)
      if (amount === null) {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZARINPAL_AMOUNT_UNSUPPORTED',
        }
      }

      const endpoints = endpointsFor(input.configuration.environment, options.endpointOrigin)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
      try {
        const response = await fetch(endpoints.verify, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            merchant_id: credential.merchantId,
            authority: input.providerReference,
            amount,
          }),
          signal: controller.signal,
        })
        const body = (await response.json().catch(() => null)) as unknown
        const data = objectField(body, 'data')
        const code = numericCode(data) ?? numericCode(objectField(body, 'errors'))

        if (code === null) {
          return {
            verified: false,
            normalizedOutcome: 'FAILED',
            reasonCode: `ZARINPAL_VERIFY_HTTP_${response.status}`,
          }
        }

        const outcome = this.mapProviderStatus(String(code))
        const refId = data?.['ref_id']
        if (outcome !== 'VERIFIED' || (typeof refId !== 'string' && typeof refId !== 'number')) {
          return {
            verified: false,
            normalizedOutcome: outcome,
            reasonCode: zarinpalCode('VERIFY', code, response.status),
          }
        }

        return {
          verified: true,
          normalizedOutcome: 'VERIFIED',
          providerReference: input.providerReference,
          externalEventId: String(refId),
          // 101 is Zarinpal's "this was already verified", which is what makes a
          // repeated verify safe rather than a double capture.
          alreadySettled: code === 101,
          // See the header comment: Zarinpal checked this number against the
          // card charge and answered -50 if they disagreed, so echoing it back
          // reports the gateway's assertion rather than our own assumption.
          settledAmount: input.expectedAmount,
        }
      } catch {
        return {
          verified: false,
          normalizedOutcome: 'FAILED',
          reasonCode: 'ZARINPAL_VERIFY_FAILED',
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

// normalizedCode must match ^[A-Z][A-Z0-9_]{1,63}$ (see payment-execution.ts), so
// the minus sign in a Zarinpal code becomes a readable NEG prefix rather than
// being stripped into an ambiguous digit.
function zarinpalCode(
  stage: 'REQUEST' | 'VERIFY',
  code: number | null,
  httpStatus: number,
): string {
  if (code === null) return `ZARINPAL_${stage}_HTTP_${httpStatus}`
  return code < 0 ? `ZARINPAL_${stage}_NEG_${-code}` : `ZARINPAL_${stage}_${code}`
}
