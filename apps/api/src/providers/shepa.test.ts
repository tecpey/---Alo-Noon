import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeInitializationResult, type ProviderPaymentRequest } from '@alo-noon/domain'

import { createShepaAdapter } from './shepa'

function credential(material: string) {
  return { material: Buffer.from(material, 'utf8'), dispose: vi.fn() }
}

function baseRequest(overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest {
  return {
    paymentAttemptId: 'attempt-1',
    amount: 250_000n,
    currency: 'IRR',
    idempotencyKey: 'idem-1',
    requestFingerprint: 'fingerprint-1',
    timeoutMs: 5_000,
    configuration: {
      id: 'config-1',
      tenantId: 'tenant-1',
      providerCode: 'SHEPA',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
      merchantReference: 'merchant-1',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION'],
      credentialReference: 'env://PAYMENT_PROVIDER_SHEPA_API_KEY',
    },
    credential: credential(JSON.stringify({ apiKey: 'test-api-key' })),
    ...overrides,
  }
}

const adapter = createShepaAdapter({
  callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Shepa adapter status mapping', () => {
  it('maps the literal success status and treats everything else as failed', () => {
    expect(adapter.mapProviderStatus('success')).toBe('VERIFIED')
    expect(adapter.mapProviderStatus('failed')).toBe('FAILED')
    expect(adapter.mapProviderStatus('cancelled')).toBe('FAILED')
  })
})

describe('Shepa adapter initialization', () => {
  it('requests a redirect on a successful token response and sends Rial (no conversion)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: { token: 'tok-abc', url: 'https://shepa.com/pay/tok-abc' },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'tok-abc',
      customerActionUrl: 'https://shepa.com/pay/tok-abc',
    })
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sandbox.shepa.com/api/v1/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('api')).toBe('test-api-key')
    expect(body.get('amount')).toBe('250000')
    expect(body.get('callback')).toBe('https://api.alonoon.ir/api/v1/payments/callback')
  })

  it('uses the production base URL when the configuration environment is PRODUCTION', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, result: { token: 't', url: 'https://shepa.com/pay/t' } }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await adapter.initializePayment!(
      baseRequest({
        configuration: {
          ...baseRequest().configuration,
          environment: 'PRODUCTION',
        },
      }),
    )

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://merchant.shepa.com/api/v1/token')
  })

  it('classifies a rejected token response as retryable with a safe normalized code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: false, errorCode: 12 }), { status: 200 }),
        ),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('RETRYABLE_FAILURE')
    expect(result.normalizedCode).toBe('SHEPA_TOKEN_12')
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()
  })

  it('treats a network failure as retryable without leaking the underlying error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')))

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      normalizedCode: 'SHEPA_REQUEST_FAILED',
      customerMessageKey: 'payment.initialization_unavailable',
    })
  })

  it('rejects a malformed credential without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ credential: credential('not-json') }),
    )

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('SHEPA_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
