import { describe, expect, it, vi } from 'vitest'

import { createExpoPushAdapter } from './expo-push'

const request = {
  token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  message: {
    title: 'پیک راه افتاد',
    body: 'سفارش TJR29BT8 راه افتاد.',
    data: { orderId: '00000000-0000-4000-8000-0000000000d9', orderCode: 'TJR29BT8' },
  },
  timeoutMs: 5_000,
  signal: { aborted: false },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function adapterWith(fetchImpl: typeof globalThis.fetch) {
  return createExpoPushAdapter({ fetch: fetchImpl, endpoint: 'https://push.test/send' })
}

describe('Expo push adapter', () => {
  it('reports a delivery and keeps the ticket', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ data: [{ status: 'ok', id: 'ticket-1' }] }))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result.outcome).toBe('DELIVERED')
    expect(result.providerReference).toBe('ticket-1')
  })

  it('sends the message Expo expects', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ data: [{ status: 'ok', id: 'ticket-1' }] }))

    await adapterWith(fetchMock).sendPush(request)

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as unknown[]
    expect(body).toEqual([
      {
        to: request.token,
        title: 'پیک راه افتاد',
        body: 'سفارش TJR29BT8 راه افتاد.',
        data: request.message.data,
        sound: 'default',
        priority: 'high',
      },
    ])
  })

  /**
   * The failure this adapter exists to catch.
   *
   * Expo answers 200 for a request it accepted and reports the per-message
   * verdict inside the body. An adapter that trusted the status code would
   * record every uninstalled app as a delivery, and the customer behind it
   * would never get the SMS that would have reached them.
   */
  it('does not call a rejected message delivered because the HTTP call was fine', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        data: [
          {
            status: 'error',
            message: '"ExponentPushToken[...]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    )

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    // Expo's own word, passed through so the retirement decision reads against
    // their documentation rather than a translation of it.
    expect(result.normalizedCode).toBe('DeviceNotRegistered')
  })

  it('names a rejection Expo did not explain', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ data: [{ status: 'error' }] }))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({ outcome: 'PERMANENT_FAILURE', normalizedCode: 'PUSH_REJECTED' })
  })

  it('lets SMS carry the message when the push service is down', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({
      outcome: 'TRANSIENT_FAILURE',
      normalizedCode: 'PROVIDER_UNAVAILABLE',
    })
  })

  it('treats a rate limit as something to try again another way', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 429))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({
      outcome: 'TRANSIENT_FAILURE',
      normalizedCode: 'MessageRateExceeded',
    })
  })

  it('does not retry a request Expo refused outright', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 400))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({ outcome: 'PERMANENT_FAILURE', normalizedCode: 'HTTP_400' })
  })

  it('reports a transport failure rather than a verdict', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('socket hang up'))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({
      outcome: 'TRANSIENT_FAILURE',
      normalizedCode: 'TRANSPORT_FAILURE',
    })
  })

  /**
   * A 200 whose body this adapter cannot read is not a delivery. Saying
   * "unknown" leaves the message to SMS; saying "delivered" loses it.
   */
  it('refuses to guess from a body it does not understand', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ok: true }))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result).toMatchObject({
      outcome: 'UNKNOWN',
      normalizedCode: 'PROVIDER_OUTCOME_UNKNOWN',
    })
  })

  it('refuses to guess from a body that is not JSON at all', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))

    const result = await adapterWith(fetchMock).sendPush(request)

    expect(result.outcome).toBe('UNKNOWN')
  })
})
