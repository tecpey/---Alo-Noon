import {
  PUSH_ADAPTER_SPI_VERSION,
  type PushMessageProvider,
  type PushSendRequest,
  type PushSendResult,
} from '@alo-noon/domain'

import {
  WebPushCryptoError,
  encryptWebPushPayload,
  vapidAuthorization,
  type VapidKeyPair,
} from './web-push-crypto.js'

/**
 * The Web Push protocol (RFC 8030), which is how a browser is reached.
 *
 * There is no vendor here. Unlike every other adapter in this folder, this one
 * does not talk to a company — it posts to whatever URL the browser handed us,
 * which is Google's push service for Chrome, Mozilla's for Firefox and Apple's
 * for Safari, all speaking the same protocol. So there is no account, no
 * merchant id and no per-tenant credential: the only configuration is this
 * platform's own VAPID key pair, which identifies the sender rather than
 * authorising it.
 *
 * On an iPhone this is not one channel among several. Apple does not accept
 * Iranian developer enrolments, so the App Store build does not exist and is
 * not going to; the shop added to a home screen is the only iPhone this
 * platform will ever reach, and this file is the only way it can speak first.
 *
 * ## "Delivered" means accepted, here as everywhere
 *
 * A push service answers 201 when it has taken responsibility for the message,
 * not when a phone has shown it. That is the same promise Expo's ticket makes
 * and the same one an SMS gateway makes, and the notification row records which
 * channel accepted the message rather than claiming anybody read it.
 */
const WEB_PUSH_ADAPTER_VERSION = '1.0.0'

/**
 * How long the push service holds a message for a browser that is offline.
 *
 * An hour, which is roughly how long any of these sentences stays true. "The
 * courier has left" delivered tomorrow morning is not a late notification, it
 * is a wrong one — the bread arrived, or did not, long before the phone came
 * back. Letting it expire is the honest outcome, and the order screen is still
 * there for anybody who wants to know what happened.
 */
const DEFAULT_TTL_SECONDS = 60 * 60

/**
 * VAPID tokens are minted per request and kept short.
 *
 * Twelve hours is well inside RFC 8292's ceiling and well past the seconds a
 * request takes. Long enough that a clock a few minutes out of step at either
 * end is not a failure; short enough that a token lifted from a log is worth
 * little.
 */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

/** RFC 8030 §5.4: at most 32 characters from the URL-safe alphabet. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export interface WebPushAdapterOptions {
  readonly keys: VapidKeyPair
  /** A `mailto:` or `https:` URI a push service operator could reach us at. */
  readonly subject: string
  /** Injected so tests never reach a push service. */
  readonly fetch?: typeof globalThis.fetch
  readonly ttlSeconds?: number
  readonly now?: () => Date
}

export function createWebPushAdapter(options: WebPushAdapterOptions): PushMessageProvider {
  const send = options.fetch ?? globalThis.fetch
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const now = options.now ?? (() => new Date())

  return {
    code: 'WEB_PUSH',
    transport: 'WEB_PUSH',
    adapterVersion: WEB_PUSH_ADAPTER_VERSION,
    spiVersion: PUSH_ADAPTER_SPI_VERSION,

    async sendPush(request: PushSendRequest): Promise<PushSendResult> {
      if (request.target.transport !== 'WEB_PUSH') {
        // The registry routes by transport, so this is a wiring mistake rather
        // than anything about the customer. Reported as permanent so it is not
        // retried, and named so it is greppable.
        return { outcome: 'PERMANENT_FAILURE', normalizedCode: 'WRONG_PUSH_TRANSPORT' }
      }
      const subscription = request.target.subscription

      let body: Buffer
      let authorization: string
      try {
        body = encryptWebPushPayload(
          Buffer.from(
            JSON.stringify({
              title: request.message.title,
              body: request.message.body,
              data: request.message.data,
            }),
            'utf8',
          ),
          { p256dh: subscription.p256dh, auth: subscription.auth },
        )
        authorization = vapidAuthorization({
          keys: options.keys,
          subject: options.subject,
          endpoint: subscription.endpoint,
          now: now(),
          lifetimeSeconds: VAPID_LIFETIME_SECONDS,
        })
      } catch (error) {
        return cryptoFailure(error)
      }

      let response: Response
      try {
        response = await send(subscription.endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(ttlSeconds),
            // The one setting a customer notices. A bakery message at six in
            // the morning is the only thing this app has to say; delivered
            // quietly it is seen at lunchtime.
            urgency: 'high',
            ...topicHeader(request.message.data['orderCode']),
          },
          // A fresh view over the encrypted record. `fetch` wants an
          // ArrayBuffer-backed body, and a Buffer from `Buffer.concat` may sit
          // inside a larger pooled allocation — passing its buffer directly
          // would send whatever else is pooled beside it.
          body: new Uint8Array(body),
          signal: request.signal as AbortSignal,
        })
      } catch {
        // Timeouts, DNS, resets. The message may or may not have gone; the SMS
        // carries it either way, which is better than a customer hearing
        // nothing because a push service was briefly unreachable.
        return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'TRANSPORT_FAILURE' }
      }

      return readStatus(response)
    },
  }
}

/**
 * A push service's answer, in the vocabulary the domain already uses.
 *
 * Translated here rather than passed through as HTTP status codes, so that
 * `pushFailureIsPermanent` states one rule about devices instead of one rule
 * per transport. 404 and 410 are the web's `DeviceNotRegistered`: a
 * subscription the browser has revoked, which arrives constantly and which must
 * retire the row or every uninstalled shop costs a request on every order.
 */
function readStatus(response: Response): PushSendResult {
  if (response.status >= 200 && response.status < 300) {
    const reference = response.headers.get('location')
    return {
      outcome: 'DELIVERED',
      // The push service's own URL for the message it accepted — the only
      // thing there is to point at when a customer says nothing arrived.
      ...(reference && { providerReference: reference }),
    }
  }
  if (response.status === 404 || response.status === 410) {
    return { outcome: 'PERMANENT_FAILURE', normalizedCode: 'DeviceNotRegistered' }
  }
  if (response.status === 401 || response.status === 403) {
    // Our VAPID keys, not this customer's subscription. Permanent because
    // retrying cannot fix it, and named so that a deployment which pasted half
    // a key pair finds out from one device rather than from all of them.
    return { outcome: 'PERMANENT_FAILURE', normalizedCode: 'InvalidCredentials' }
  }
  if (response.status === 413) {
    return { outcome: 'PERMANENT_FAILURE', normalizedCode: 'MessageTooBig' }
  }
  if (response.status === 429) {
    return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'MessageRateExceeded' }
  }
  if (response.status >= 500) {
    return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'PROVIDER_UNAVAILABLE' }
  }
  return { outcome: 'PERMANENT_FAILURE', normalizedCode: `HTTP_${response.status}` }
}

/**
 * A failure before anything was sent.
 *
 * The distinction that matters is whose fault it is. A subscription whose keys
 * will not encrypt is finished and the row should be retired. A VAPID key pair
 * that will not sign is this deployment's configuration, and retiring devices
 * over it would quietly empty the customer's list of handsets while an operator
 * fixed an environment variable.
 */
function cryptoFailure(error: unknown): PushSendResult {
  if (!(error instanceof WebPushCryptoError)) {
    return { outcome: 'UNKNOWN', normalizedCode: 'PROVIDER_OUTCOME_UNKNOWN' }
  }
  if (error.code.startsWith('VAPID_')) {
    return { outcome: 'TRANSIENT_FAILURE', normalizedCode: error.code }
  }
  if (error.code === 'PUSH_PAYLOAD_TOO_LARGE') {
    return { outcome: 'PERMANENT_FAILURE', normalizedCode: 'MessageTooBig' }
  }
  return { outcome: 'PERMANENT_FAILURE', normalizedCode: error.code }
}

/**
 * Collapsing messages a customer has not seen yet.
 *
 * A phone that has been off since morning should not light up with "your bread
 * is ready", "the courier has left" and "delivered" in a stack. RFC 8030's
 * Topic replaces an undelivered message with the next one carrying the same
 * topic, so what waits at the push service is always the current state of that
 * order — which is the only one of the three that is still true.
 *
 * Only undelivered messages collapse. A customer whose phone is on receives
 * each step as it happens, exactly as before.
 */
function topicHeader(orderCode: string | undefined): Record<string, string> {
  return orderCode && TOPIC_PATTERN.test(orderCode) ? { topic: orderCode } : {}
}
