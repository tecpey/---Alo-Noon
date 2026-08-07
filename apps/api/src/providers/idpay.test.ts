import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeInitializationResult, type ProviderPaymentRequest } from '@alo-noon/domain'

import { createIdPayAdapter } from './idpay'

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
      providerCode: 'IDPAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
      merchantReference: 'merchant-1',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION'],
      credentialReference: 'env://PAYMENT_PROVIDER_IDPAY_API_KEY',
    },
    credential: credential(JSON.stringify({ apiKey: 'test-api-key' })),
    ...overrides,
  }
}

const adapter = createIdPayAdapter({
  callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('IDPay adapter status mapping', () => {
  it.each([
    ['100', 'VERIFIED'],
    ['101', 'VERIFIED'],
    ['200', 'VERIFIED'],
    ['10', 'PENDING'],
    ['8', 'CUSTOMER_ACTION_REQUIRED'],
    ['7', 'REJECTED'],
    ['2', 'FAILED'],
    ['9999', 'FAILED'],
  ])('maps status code %s to %s', (code, outcome) => {
    expect(adapter.mapProviderStatus(code)).toBe(outcome)
  })
})

describe('IDPay adapter initialization', () => {
  it('requests a redirect on a successful transaction creation and sends Rial with sandbox header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'tx-abc', link: 'https://idpay.ir/p/tx-abc' }), {
        status: 201,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'tx-abc',
      customerActionUrl: 'https://idpay.ir/p/tx-abc',
    })
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.idpay.ir/v1.1/payment')
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('test-api-key')
    expect((init.headers as Record<string, string>)['X-SANDBOX']).toBe('true')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      order_id: 'attempt-1',
      amount: '250000',
      callback: 'https://api.alonoon.ir/api/v1/payments/callback',
    })
  })

  it('sends X-SANDBOX: false when the configuration environment is PRODUCTION', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'tx', link: 'https://idpay.ir/p/tx' }), { status: 201 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await adapter.initializePayment!(
      baseRequest({
        configuration: { ...baseRequest().configuration, environment: 'PRODUCTION' },
      }),
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-SANDBOX']).toBe('false')
  })

  it('classifies a rejected transaction as retryable with a safe normalized code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error_code: 41 }), { status: 400 })),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('RETRYABLE_FAILURE')
    expect(result.normalizedCode).toBe('IDPAY_TOKEN_41')
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()
  })

  it('treats a network failure as retryable without leaking the underlying error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')))

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      normalizedCode: 'IDPAY_REQUEST_FAILED',
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
    expect(result.normalizedCode).toBe('IDPAY_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
