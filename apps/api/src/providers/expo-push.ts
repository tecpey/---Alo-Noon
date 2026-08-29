import {
  PUSH_ADAPTER_SPI_VERSION,
  type PushMessageProvider,
  type PushSendRequest,
  type PushSendResult,
} from '@alo-noon/domain'

/**
 * Expo's push service, which is how a React Native app is reached.
 *
 * Not APNs and FCM directly, and that is deliberate. Talking to Apple and
 * Google separately means two credential stories, two token formats, two sets
 * of certificate expiries and a p8 key that has to live somewhere — for an
 * app that is already built and shipped through Expo, which does exactly that
 * work behind one endpoint. If this platform ever leaves Expo, this file is
 * what gets replaced, and the SPI it satisfies is what makes that possible.
 *
 * No credential. Expo accepts unauthenticated sends to its own tokens, and the
 * token itself is the authorisation — you can only push to a device that handed
 * you its token. An access token can be added later for the enhanced security
 * setting; the SPI already carries nothing about credentials for this channel
 * so adding one does not change the shape.
 *
 * The important part of this adapter is not the POST. It is reading the ticket:
 * Expo answers HTTP 200 for a request it accepted and then reports per-message
 * failure inside the body. A naive adapter that checks the status code reports
 * every uninstalled app as a successful delivery, and the customer behind it
 * never gets the SMS that would have reached them.
 */
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'
const EXPO_PUSH_ADAPTER_VERSION = '1.0.0'

export interface ExpoPushAdapterOptions {
  /** Injected so tests never reach the network. */
  fetch?: typeof globalThis.fetch
  endpoint?: string
}

interface ExpoTicket {
  status?: unknown
  id?: unknown
  message?: unknown
  details?: { error?: unknown } | null
}

export function createExpoPushAdapter(options: ExpoPushAdapterOptions = {}): PushMessageProvider {
  const send = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoint ?? EXPO_PUSH_ENDPOINT

  return {
    code: 'EXPO',
    adapterVersion: EXPO_PUSH_ADAPTER_VERSION,
    spiVersion: PUSH_ADAPTER_SPI_VERSION,

    async sendPush(request: PushSendRequest): Promise<PushSendResult> {
      let response: Response
      try {
        response = await send(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Expo will gzip a reply otherwise, and asking for identity keeps
            // the failure modes down to ones this adapter can read.
            'accept-encoding': 'identity',
            accept: 'application/json',
          },
          body: JSON.stringify([
            {
              to: request.token,
              title: request.message.title,
              body: request.message.body,
              data: request.message.data,
              // The two settings a customer actually notices. `default` sound
              // rather than silence: a bakery message at 6am is the one thing
              // this app has to say, and a silent notification is one nobody
              // sees until lunchtime.
              sound: 'default',
              priority: 'high',
            },
          ]),
          signal: request.signal as AbortSignal,
        })
      } catch {
        // Timeouts, DNS, resets. The message may or may not have gone; SMS
        // carries it either way, which is better than a customer hearing
        // nothing because a push service was briefly unreachable.
        return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'TRANSPORT_FAILURE' }
      }

      if (response.status >= 500) {
        return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'PROVIDER_UNAVAILABLE' }
      }
      if (response.status === 429) {
        return { outcome: 'TRANSIENT_FAILURE', normalizedCode: 'MessageRateExceeded' }
      }
      if (!response.ok) {
        return { outcome: 'PERMANENT_FAILURE', normalizedCode: `HTTP_${response.status}` }
      }

      let ticket: ExpoTicket | undefined
      try {
        const payload: unknown = await response.json()
        const data: unknown = (payload as { data?: unknown } | null)?.data
        ticket = Array.isArray(data) ? (data[0] as ExpoTicket | undefined) : undefined
      } catch {
        return { outcome: 'UNKNOWN', normalizedCode: 'PROVIDER_OUTCOME_UNKNOWN' }
      }

      // A 200 with no ticket in it is a shape this adapter does not understand.
      // Reported as unknown rather than delivered: claiming a send happened
      // because the HTTP call did is the mistake this whole function exists to
      // avoid.
      if (!ticket || typeof ticket.status !== 'string') {
        return { outcome: 'UNKNOWN', normalizedCode: 'PROVIDER_OUTCOME_UNKNOWN' }
      }

      if (ticket.status === 'ok') {
        return {
          outcome: 'DELIVERED',
          ...(typeof ticket.id === 'string' && { providerReference: ticket.id }),
        }
      }

      // `details.error` is Expo's own vocabulary — DeviceNotRegistered,
      // MessageTooBig, MessageRateExceeded — and the domain decides from it
      // whether the token is finished. Passed through rather than translated so
      // that decision reads against Expo's documentation.
      const error = ticket.details?.error
      return {
        outcome: 'PERMANENT_FAILURE',
        normalizedCode: typeof error === 'string' ? error : 'PUSH_REJECTED',
      }
    },
  }
}
