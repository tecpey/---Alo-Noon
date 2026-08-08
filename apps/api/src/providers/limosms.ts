import {
  AUTH_DELIVERY_ADAPTER_SPI_VERSION,
  type AuthenticationDeliveryProvider,
  type AuthenticationDeliveryRequest,
  type AuthenticationDeliveryResult,
  type ResolvedAuthenticationCredential,
  type TextMessageProvider,
  type TextMessageRequest,
} from '@alo-noon/domain'

/**
 * LimooSMS — the OTP delivery gateway.
 *
 * One endpoint, documented as:
 *
 *     POST https://api.limosms.com/api/sendsms
 *     ApiKey: <access code>          (header, not body)
 *     { "Message": "...", "SenderNumber": "...", "MobileNumber": ["09..."] }
 *
 * and answering `{ Success, Message, MessageId[] }`.
 *
 * Two things about that contract shape the adapter more than anything else.
 *
 * **There are no error codes.** The gateway reports a boolean and a Persian
 * sentence, so there is no reliable way to tell "insufficient credit" from
 * "temporary glitch". Guessing from the text would be a parser tied to wording
 * that can change without notice. So the retry decision is made from what *is*
 * unambiguous — the transport — and a definite `Success: false` is treated as
 * final: the gateway answered, it just said no. Retrying that would spend
 * credit and send a second message for a reason we invented.
 *
 * **There is no template endpoint.** Iranian gateways often have a separate
 * pattern API for one-time codes, which carriers deliver more reliably. This one
 * does not, so the code is rendered into the tenant's own message text — edited
 * in the admin panel, carried on the request as `messageBody` — and sent as
 * ordinary SMS. If LimooSMS adds a pattern API later, the configuration's
 * `templateReference` is already the right place to name the pattern, and the
 * unsubstituted code is already on the request.
 */
const LIMOSMS_ENDPOINT = 'https://api.limosms.com/api/sendsms'

/** Where the OTP is substituted into the tenant's message. */
const OTP_PLACEHOLDER = '{code}'

interface LimoSmsResponse {
  Success?: unknown
  Message?: unknown
  MessageId?: unknown
}

export interface LimoSmsAdapterOptions {
  /** Injected so tests never reach the network. */
  fetch?: typeof globalThis.fetch
  endpoint?: string
}

/**
 * One adapter, both jobs.
 *
 * A one-time code and an order notification are the same POST to the same
 * endpoint; what differs is the policy around them, which lives elsewhere. The
 * two entry points share `postMessage` so a change to how this gateway is
 * spoken to cannot be applied to one of them and forgotten on the other.
 */
export function createLimoSmsAdapter(
  options: LimoSmsAdapterOptions = {},
): AuthenticationDeliveryProvider & TextMessageProvider {
  const send = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoint ?? LIMOSMS_ENDPOINT

  async function postMessage(input: {
    mobileE164: string
    message: string
    senderReference: string
    credential: ResolvedAuthenticationCredential
    signal: unknown
  }): Promise<AuthenticationDeliveryResult> {
    const mobile = toIranianLocal(input.mobileE164)
    if (!mobile) {
      // Not the gateway's problem and not worth a round trip: a number this
      // gateway cannot address will never become deliverable by retrying.
      input.credential.dispose()
      return {
        outcome: 'PERMANENT_FAILURE',
        normalizedCode: 'UNSUPPORTED_MOBILE',
        retryable: false,
      }
    }

    let response: Response
    try {
      response = await send(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The credential is a header, never a body field, so it stays out
          // of anything that logs a request payload.
          ApiKey: new TextDecoder().decode(input.credential.material),
        },
        body: JSON.stringify({
          Message: input.message,
          SenderNumber: input.senderReference,
          MobileNumber: [mobile],
        }),
        signal: input.signal as AbortSignal,
      })
    } catch {
      // Timeouts, DNS, connection resets: the message may or may not have
      // been sent, and only a retry can find out.
      return {
        outcome: 'TRANSIENT_FAILURE',
        normalizedCode: 'TRANSPORT_FAILURE',
        retryable: true,
      }
    } finally {
      // The key is needed for exactly one call; holding it any longer widens
      // the window in which a heap dump would contain it.
      input.credential.dispose()
    }

    if (response.status >= 500) {
      return {
        outcome: 'TRANSIENT_FAILURE',
        normalizedCode: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      }
    }
    if (response.status === 401 || response.status === 403) {
      // A bad key does not fix itself, and every retry burns a rate-limit
      // slot on a request that cannot succeed.
      return {
        outcome: 'PERMANENT_FAILURE',
        normalizedCode: 'PROVIDER_UNAUTHORIZED',
        retryable: false,
      }
    }
    if (!response.ok) {
      return { outcome: 'REJECTED', normalizedCode: `HTTP_${response.status}`, retryable: false }
    }

    const payload = (await response.json().catch(() => null)) as LimoSmsResponse | null
    if (payload === null || typeof payload.Success !== 'boolean') {
      // A 200 whose body is not the documented shape means the gateway is
      // answering something else. Treated as unknown rather than delivered:
      // reporting a code sent that may not have been is the worse mistake.
      return { outcome: 'UNKNOWN', normalizedCode: 'MALFORMED_RESPONSE', retryable: false }
    }
    if (!payload.Success) {
      // The gateway gave a definite no. Without documented codes there is
      // nothing to distinguish a retryable no from a final one, so it is
      // final — a retry would spend credit on a guess.
      return { outcome: 'REJECTED', normalizedCode: 'PROVIDER_REJECTED', retryable: false }
    }

    const reference = firstMessageId(payload.MessageId)
    return {
      outcome: 'DELIVERED',
      ...(reference && { providerReference: reference }),
      normalizedCode: 'ACCEPTED',
      retryable: false,
    }
  }

  return {
    code: 'LIMOSMS',
    adapterVersion: '1.0.0',
    spiVersion: AUTH_DELIVERY_ADAPTER_SPI_VERSION,

    deliverOtp(request: AuthenticationDeliveryRequest): Promise<AuthenticationDeliveryResult> {
      return postMessage({
        mobileE164: request.mobileE164,
        message: renderMessage(request.messageBody, request.otp),
        senderReference: request.configuration.senderReference,
        credential: request.credential,
        signal: request.signal,
      })
    },

    /**
     * Order notifications arrive already rendered: their template was resolved
     * and filled before a provider was chosen, so there is nothing left to
     * substitute here.
     */
    sendText(request: TextMessageRequest): Promise<AuthenticationDeliveryResult> {
      return postMessage({
        mobileE164: request.mobileE164,
        message: request.body,
        senderReference: request.senderReference,
        credential: request.credential,
        signal: request.signal,
      })
    },
  }
}

/**
 * Renders the OTP into the tenant's message.
 *
 * The panel refuses to save a sign-in message without `{code}` in it, so this
 * should never have to append. It does anyway, because the fallback path — a
 * tenant with no template row at all — does not go through that validation, and
 * an awkward message beats a customer who cannot sign in.
 */
function renderMessage(template: string, otp: string): string {
  return template.includes(OTP_PLACEHOLDER)
    ? template.split(OTP_PLACEHOLDER).join(otp)
    : `${template} ${otp}`.trim()
}

/**
 * The gateway addresses Iranian mobiles in local `09xxxxxxxxx` form; the system
 * stores E.164. Anything that is not an Iranian mobile returns null rather than
 * being coerced into something that looks like one.
 */
function toIranianLocal(mobileE164: string): string | null {
  const match = /^\+98(9\d{9})$/.exec(mobileE164)
  return match ? `0${match[1]}` : null
}

/**
 * The gateway returns an array of message ids, one per recipient. We send to
 * exactly one, so the first is the reference for this delivery.
 */
function firstMessageId(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const first = value[0]
  return typeof first === 'string' && first.length > 0 && first.length <= 200 ? first : null
}
