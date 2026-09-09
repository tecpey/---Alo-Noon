import { describe, expect, it, vi } from 'vitest'

import type { AuthenticationDeliveryRequest } from '@alo-noon/domain'

import { createLimoSmsAdapter } from './limosms'

/**
 * The gateway reports a boolean and a Persian sentence, with no error codes at
 * all. Everything below is about that: which failures are worth retrying when
 * the provider will not say, and refusing to report a code delivered that may
 * not have been.
 */
const disposals: string[] = []

function requestFor(overrides: Partial<AuthenticationDeliveryRequest> = {}) {
  return {
    challengeId: 'c1',
    deliveryAttemptId: 'd1',
    mobileE164: '+989121234567',
    otp: '004231',
    expiresAt: new Date('2026-08-08T09:05:00.000Z'),
    idempotencyKey: 'limo-otp-0000000001',
    requestFingerprint: 'f'.repeat(64),
    timeoutMs: 10_000,
    signal: { aborted: false, addEventListener: () => {} },
    messageBody: 'کد ورود شما: {code}',
    configuration: {
      id: 'cfg',
      tenantId: 't1',
      providerCode: 'LIMOSMS',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'PRODUCTION',
      credentialReference: 'env://AUTH_SMS_LIMOSMS_KEY',
      senderReference: '3000...',
      // Kept for a gateway with a real pattern API; this one sends text, so
      // the wording comes from messageBody above.
      templateReference: 'otp-fa',
    },
    credential: {
      material: new TextEncoder().encode('secret-key'),
      dispose: () => disposals.push('disposed'),
    },
    ...overrides,
  } as unknown as AuthenticationDeliveryRequest
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('LimooSMS adapter', () => {
  it('sends the key as a header and the code in the templated message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ Success: true, Message: 'ارسال شد', MessageId: ['m-1'] }))
    const adapter = createLimoSmsAdapter({ fetch: fetchMock as never })

    const result = await adapter.deliverOtp(requestFor())

    expect(result).toMatchObject({ outcome: 'DELIVERED', providerReference: 'm-1' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.limosms.com/api/sendsms')
    // The credential is a header, so a logged request body never carries it.
    expect((init.headers as Record<string, string>)['ApiKey']).toBe('secret-key')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      Message: 'کد ورود شما: 004231',
      SenderNumber: '3000...',
      // Local Iranian form, which is what this gateway addresses.
      MobileNumber: ['09121234567'],
    })
    expect(JSON.stringify(body)).not.toContain('secret-key')
  })

  it('appends the code when the message forgot the placeholder', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ Success: true, Message: 'ok', MessageId: ['m-2'] }))
    const adapter = createLimoSmsAdapter({ fetch: fetchMock as never })

    // The panel refuses to save this, but a tenant with no template row at all
    // never went through that validation.
    await adapter.deliverOtp(requestFor({ messageBody: 'کد ورود شما' } as never))

    // A customer who cannot sign in is worse than an awkward message.
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.Message).toBe('کد ورود شما 004231')
  })

  it('disposes the credential even when the call fails', async () => {
    disposals.length = 0
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const adapter = createLimoSmsAdapter({ fetch: fetchMock as never })

    const result = await adapter.deliverOtp(requestFor())

    expect(result).toMatchObject({ outcome: 'TRANSIENT_FAILURE', retryable: true })
    expect(disposals).toEqual(['disposed'])
  })

  it('retries only what the transport says is worth retrying', async () => {
    const cases: ReadonlyArray<[number, string, boolean]> = [
      // The gateway is down; the message may or may not have gone.
      [500, 'TRANSIENT_FAILURE', true],
      [503, 'TRANSIENT_FAILURE', true],
      // A bad key does not fix itself.
      [401, 'PERMANENT_FAILURE', false],
      [403, 'PERMANENT_FAILURE', false],
      [400, 'REJECTED', false],
    ]
    for (const [status, outcome, retryable] of cases) {
      const adapter = createLimoSmsAdapter({
        fetch: vi.fn().mockResolvedValue(new Response('', { status })) as never,
      })
      expect(await adapter.deliverOtp(requestFor())).toMatchObject({ outcome, retryable })
    }
  })

  it('treats a definite rejection as final, because the gateway gives no codes', async () => {
    const adapter = createLimoSmsAdapter({
      fetch: vi
        .fn()
        .mockResolvedValue(jsonResponse({ Success: false, Message: 'اعتبار کافی نیست' })) as never,
    })

    // Without documented codes there is nothing to distinguish a retryable no
    // from a final one, and a retry would spend credit on a guess.
    expect(await adapter.deliverOtp(requestFor())).toMatchObject({
      outcome: 'REJECTED',
      normalizedCode: 'PROVIDER_REJECTED',
      retryable: false,
    })
  })

  it('never reports a code delivered on a body it does not recognise', async () => {
    for (const body of [{}, { Success: 'true' }, 'not json at all']) {
      const adapter = createLimoSmsAdapter({
        fetch: vi
          .fn()
          .mockResolvedValue(
            typeof body === 'string' ? new Response(body, { status: 200 }) : jsonResponse(body),
          ) as never,
      })
      expect(await adapter.deliverOtp(requestFor())).toMatchObject({
        outcome: 'UNKNOWN',
        normalizedCode: 'MALFORMED_RESPONSE',
      })
    }
  })

  it('refuses a number this gateway cannot address, without a round trip', async () => {
    const fetchMock = vi.fn()
    const adapter = createLimoSmsAdapter({ fetch: fetchMock as never })

    for (const mobileE164 of ['+14155550100', '+98211234567', '09121234567']) {
      expect(await adapter.deliverOtp(requestFor({ mobileE164 }))).toMatchObject({
        outcome: 'PERMANENT_FAILURE',
        normalizedCode: 'UNSUPPORTED_MOBILE',
        retryable: false,
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tolerates a success with no message id', async () => {
    const adapter = createLimoSmsAdapter({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ Success: true, Message: 'ok' })) as never,
    })
    const result = await adapter.deliverOtp(requestFor())
    expect(result.outcome).toBe('DELIVERED')
    expect(result.providerReference).toBeUndefined()
  })
})
