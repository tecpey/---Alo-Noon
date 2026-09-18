import { describe, expect, it, vi } from 'vitest'

import { createWebPushAdapter } from './web-push'
import { generateVapidKeys } from './web-push-crypto'

/**
 * The adapter around the encryption, which is tested separately against the
 * RFCs themselves.
 *
 * What is checked here is the part a push service can tell us about: the
 * request it receives, and what its answer means. The mapping from status codes
 * matters more than it looks — 410 treated as retryable means every revoked
 * subscription costs a request on every order and the customer behind it never
 * falls back to SMS, and 403 treated as the device's fault would quietly empty
 * every customer's device list while an operator fixed an environment variable.
 */

const keys = generateVapidKeys()

const subscription = {
  endpoint: 'https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}

const request = {
  target: { transport: 'WEB_PUSH' as const, subscription },
  message: {
    title: 'پیک راه افتاد',
    body: 'سفارش TJR29BT8 راه افتاد.',
    data: {
      orderId: '00000000-0000-4000-8000-0000000000d9',
      orderCode: 'TJR29BT8',
      purpose: 'ORDER_OUT_FOR_DELIVERY',
    },
  },
  timeoutMs: 4_000,
  signal: { aborted: false },
}

function adapter(fetchMock: ReturnType<typeof vi.fn>) {
  return createWebPushAdapter({
    keys,
    subject: 'mailto:ops@alonoon.example',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  })
}

function accepted(status = 201, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

describe('posting a push message', () => {
  it('sends the protocol’s own headers and an encrypted body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted())
    const result = await adapter(fetchMock).sendPush(request)

    expect(result.outcome).toBe('DELIVERED')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(subscription.endpoint)
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(headers['urgency']).toBe('high')
    expect(Number(headers['ttl'])).toBeGreaterThan(0)
    // RFC 8292's scheme: the token, then the key that signed it.
    const authorization = headers['authorization'] ?? ''
    expect(authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
    expect(authorization.endsWith(`, k=${keys.publicKey}`)).toBe(true)
  })

  it('sends ciphertext rather than the message', async () => {
    // The push service forwards a payload it cannot read. If the sentence were
    // findable in the body, it would be readable by Google, by Mozilla, and by
    // anybody between here and them.
    const fetchMock = vi.fn().mockResolvedValue(accepted())
    await adapter(fetchMock).sendPush(request)

    const body = Buffer.from(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as Uint8Array,
    )
    expect(body.includes(Buffer.from(request.message.body, 'utf8'))).toBe(false)
    expect(body.includes(Buffer.from(request.message.data.orderCode, 'utf8'))).toBe(false)
    // 86 octets of header, the JSON, its delimiter and a 16-octet tag.
    const plaintext = Buffer.byteLength(
      JSON.stringify({
        title: request.message.title,
        body: request.message.body,
        data: request.message.data,
      }),
      'utf8',
    )
    expect(body.byteLength).toBe(86 + plaintext + 1 + 16)
  })

  /**
   * A phone that has been off since morning should not light up with "your
   * bread is ready", "the courier has left" and "delivered" in a stack. The
   * topic replaces whichever of them is still undelivered, so what waits is the
   * only one that is still true.
   */
  it('names the order as the topic, so superseded messages collapse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted())
    await adapter(fetchMock).sendPush(request)
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >
    expect(headers['topic']).toBe('TJR29BT8')
  })

  it('omits the topic rather than sending one the protocol forbids', async () => {
    // RFC 8030 allows at most 32 URL-safe characters. A push service rejects
    // anything else outright, which would lose the message over a formatting
    // detail rather than collapse it.
    const fetchMock = vi.fn().mockResolvedValue(accepted())
    await adapter(fetchMock).sendPush({
      ...request,
      message: { ...request.message, data: { ...request.message.data, orderCode: 'کد سفارش' } },
    })
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >
    expect(headers['topic']).toBeUndefined()
  })

  it('keeps the push service’s own reference for the message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(accepted(201, { location: 'https://push.example.net/m/abc' }))
    const result = await adapter(fetchMock).sendPush(request)
    expect(result.providerReference).toBe('https://push.example.net/m/abc')
  })
})

describe('reading what a push service answered', () => {
  const cases: ReadonlyArray<[number, string, string]> = [
    // The one that arrives constantly: a subscription the browser revoked.
    [404, 'PERMANENT_FAILURE', 'DeviceNotRegistered'],
    [410, 'PERMANENT_FAILURE', 'DeviceNotRegistered'],
    // Our VAPID keys, not this customer's subscription.
    [401, 'PERMANENT_FAILURE', 'InvalidCredentials'],
    [403, 'PERMANENT_FAILURE', 'InvalidCredentials'],
    [413, 'PERMANENT_FAILURE', 'MessageTooBig'],
    [429, 'TRANSIENT_FAILURE', 'MessageRateExceeded'],
    [500, 'TRANSIENT_FAILURE', 'PROVIDER_UNAVAILABLE'],
    [503, 'TRANSIENT_FAILURE', 'PROVIDER_UNAVAILABLE'],
    [400, 'PERMANENT_FAILURE', 'HTTP_400'],
  ]

  for (const [status, outcome, code] of cases) {
    it(`reads ${status} as ${code}`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(accepted(status))
      expect(await adapter(fetchMock).sendPush(request)).toEqual({
        outcome,
        normalizedCode: code,
      })
    })
  }

  it('treats a network failure as transient, so the SMS carries the message', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    expect(await adapter(fetchMock).sendPush(request)).toEqual({
      outcome: 'TRANSIENT_FAILURE',
      normalizedCode: 'TRANSPORT_FAILURE',
    })
  })
})

describe('failing before anything is sent', () => {
  it('retires a subscription whose keys will not encrypt', async () => {
    const fetchMock = vi.fn()
    const result = await adapter(fetchMock).sendPush({
      ...request,
      target: {
        transport: 'WEB_PUSH',
        subscription: { ...subscription, p256dh: subscription.p256dh.slice(4) },
      },
    })
    expect(result).toEqual({
      outcome: 'PERMANENT_FAILURE',
      normalizedCode: 'PUSH_SUBSCRIPTION_KEY_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * Half of one VAPID pair and half of another. Reported as transient on
   * purpose: it is this deployment's configuration, and retiring devices over
   * it would empty every customer's device list while somebody fixed an
   * environment variable.
   */
  it('does not blame the customer’s browser for our own keys', async () => {
    const fetchMock = vi.fn()
    const mismatched = createWebPushAdapter({
      keys: { publicKey: generateVapidKeys().publicKey, privateKey: keys.privateKey },
      subject: 'mailto:ops@alonoon.example',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(await mismatched.sendPush(request)).toEqual({
      outcome: 'TRANSIENT_FAILURE',
      normalizedCode: 'VAPID_KEY_PAIR_MISMATCH',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an Expo token handed to it by mistake', async () => {
    const fetchMock = vi.fn()
    const result = await adapter(fetchMock).sendPush({
      ...request,
      target: { transport: 'EXPO', expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' },
    })
    expect(result.normalizedCode).toBe('WRONG_PUSH_TRANSPORT')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
