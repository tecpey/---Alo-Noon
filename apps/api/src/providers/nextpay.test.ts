import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeInitializationResult, type ProviderPaymentRequest } from '@alo-noon/domain'

import { createNextPayAdapter } from './nextpay'

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
      providerCode: 'NEXTPAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
      merchantReference: 'merchant-1',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION'],
      credentialReference: 'env://PAYMENT_PROVIDER_NEXTPAY_API_KEY',
    },
    credential: credential(JSON.stringify({ apiKey: 'test-api-key' })),
    ...overrides,
  }
}

const adapter = createNextPayAdapter({
  callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NextPay adapter status mapping', () => {
  it.each([
    ['0', 'VERIFIED'],
    ['-1', 'PENDING'],
    ['-2', 'FAILED'],
    ['-40', 'FAILED'],
  ])('maps verify code %s to %s', (code, outcome) => {
    expect(adapter.mapProviderStatus(code)).toBe(outcome)
  })
})

describe('NextPay adapter initialization', () => {
  it('requests a redirect on a successful token response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: -1, trans_id: 'trans-abc' }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'trans-abc',
      customerActionUrl: 'https://api.nextpay.org/gateway/payment/trans-abc',
    })
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.nextpay.org/gateway/token.http')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('api_key')).toBe('test-api-key')
    expect(body.get('order_id')).toBe('attempt-1')
    expect(body.get('amount')).toBe('25000')
    expect(body.get('callback_uri')).toBe('https://api.alonoon.ir/api/v1/payments/callback')
  })

  it('classifies an incorrect API key as a permanent failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: -33 }), { status: 200 })),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('NEXTPAY_TOKEN_NEG33')
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()
  })

  it('classifies a bank-side failure code as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: -2 }), { status: 200 })),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('RETRYABLE_FAILURE')
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()
  })

  it('treats a network failure as retryable without leaking the underlying error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.nextpay.org')),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      normalizedCode: 'NEXTPAY_REQUEST_FAILED',
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
    expect(result.normalizedCode).toBe('NEXTPAY_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an amount that is not a whole number of Toman without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest({ amount: 250_005n }))

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('NEXTPAY_AMOUNT_NOT_TOMAN_ALIGNED')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
