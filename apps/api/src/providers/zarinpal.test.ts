import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  evaluateSettlement,
  normalizeInitializationResult,
  SettlementDecision,
  type ProviderPaymentRequest,
  type ProviderVerificationInput,
} from '@alo-noon/domain'

import { createZarinpalAdapter } from './zarinpal'

const AMOUNT = 250_000n
const AUTHORITY = 'A00000000000000000000000000123456789'

function credential(material: string) {
  return { material: Buffer.from(material, 'utf8'), dispose: vi.fn() }
}

function configuration(environment: 'TEST' | 'PRODUCTION' = 'TEST') {
  return {
    id: 'config-1',
    tenantId: 'tenant-1',
    providerCode: 'ZARINPAL',
    adapterVersion: '1.0.0',
    adapterSpiVersion: 1 as const,
    environment,
    merchantReference: 'merchant-1',
    callbackPolicy: 'SIGNED_ONLY' as const,
    capabilities: ['PAYMENT_INITIALIZATION' as const],
    credentialReference: 'local-encrypted://zarinpal',
  }
}

function baseRequest(overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest {
  return {
    paymentAttemptId: 'attempt-1',
    amount: AMOUNT,
    currency: 'IRR',
    idempotencyKey: 'idem-1',
    requestFingerprint: 'fingerprint-1',
    timeoutMs: 5_000,
    configuration: configuration(),
    credential: credential(JSON.stringify({ merchantId: 'merchant-uuid' })),
    ...overrides,
  }
}

function baseVerification(
  overrides: Partial<ProviderVerificationInput> = {},
): ProviderVerificationInput {
  return {
    canonicalBody: new TextEncoder().encode('{}'),
    approvedHeaders: {},
    receivedAt: new Date('2026-08-26T09:00:00.000Z'),
    configuration: configuration(),
    credential: credential(JSON.stringify({ merchantId: 'merchant-uuid' })),
    providerReference: AUTHORITY,
    expectedAmount: AMOUNT,
    paymentAttemptId: 'attempt-1',
    timeoutMs: 5_000,
    ...overrides,
  }
}

/** Zarinpal puts an empty array where the other half of the envelope would be. */
function success(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ data, errors: [] }), { status })
}
function failure(code: number, status = 400) {
  return new Response(
    JSON.stringify({ data: [], errors: { code, message: 'خطا', validations: [] } }),
    { status },
  )
}

const adapter = createZarinpalAdapter({
  callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback/zarinpal',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Zarinpal adapter status mapping', () => {
  it.each([
    ['100', 'VERIFIED'],
    ['101', 'VERIFIED'],
    ['-50', 'REJECTED'],
    ['-51', 'REJECTED'],
    ['-54', 'REJECTED'],
    ['-52', 'FAILED'],
    ['-9', 'FAILED'],
    ['not-a-code', 'FAILED'],
  ])('maps code %s to %s', (code, outcome) => {
    expect(adapter.mapProviderStatus(code)).toBe(outcome)
  })
})

describe('Zarinpal adapter initialization', () => {
  it('sends Rial with an explicit currency and redirects to the sandbox StartPay', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => success({ code: 100, authority: AUTHORITY }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: AUTHORITY,
      customerActionUrl: `https://sandbox.zarinpal.com/pg/StartPay/${AUTHORITY}`,
    })
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sandbox.zarinpal.com/pg/v4/payment/request.json')
    expect(JSON.parse(init.body as string)).toEqual({
      merchant_id: 'merchant-uuid',
      amount: 250_000,
      currency: 'IRR',
      callback_url: 'https://api.alonoon.ir/api/v1/payments/callback/zarinpal',
      description: 'پرداخت سفارش',
    })
  })

  it('uses the live gateway for a PRODUCTION configuration', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => success({ code: 100, authority: AUTHORITY }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ configuration: configuration('PRODUCTION') }),
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.zarinpal.com/pg/v4/payment/request.json')
    expect(result.customerActionUrl).toBe(`https://www.zarinpal.com/pg/StartPay/${AUTHORITY}`)
  })

  it('honours an endpoint origin override while keeping Zarinpal paths', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => success({ code: 100, authority: AUTHORITY }))
    vi.stubGlobal('fetch', fetchMock)

    const local = createZarinpalAdapter({
      callbackUrl: 'http://localhost:3001/api/v1/payments/callback/zarinpal',
      endpointOrigin: 'http://127.0.0.1:4180/',
    })
    const result = await local.initializePayment!(
      baseRequest({ configuration: configuration('PRODUCTION') }),
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4180/pg/v4/payment/request.json')
    expect(result.customerActionUrl).toBe(`http://127.0.0.1:4180/pg/StartPay/${AUTHORITY}`)
  })

  it('treats a merchant-configuration error as permanent so it is not retried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-11)),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('ZARINPAL_REQUEST_NEG_11')
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()
  })

  it('treats rate limiting and unclassified codes as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-12)),
    )
    expect((await adapter.initializePayment!(baseRequest())).outcome).toBe('RETRYABLE_FAILURE')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-9999)),
    )
    const unknown = await adapter.initializePayment!(baseRequest())
    expect(unknown.outcome).toBe('RETRYABLE_FAILURE')
    expect(unknown.normalizedCode).toBe('ZARINPAL_REQUEST_NEG_9999')
  })

  it('refuses a body that carries no authority even with a success code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => success({ code: 100 })),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('RETRYABLE_FAILURE')
  })

  it('rejects a malformed credential without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ credential: credential('not-json') }),
    )

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('ZARINPAL_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an amount JSON cannot carry exactly rather than sending it rounded', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    )

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('ZARINPAL_AMOUNT_UNSUPPORTED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a network failure as retryable without leaking the underlying error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')))

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      normalizedCode: 'ZARINPAL_REQUEST_FAILED',
      customerMessageKey: 'payment.initialization_unavailable',
    })
  })
})

describe('Zarinpal adapter verification', () => {
  it('sends the expected amount and reports it as settled once Zarinpal confirms', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        success({ code: 100, ref_id: 201_534, card_pan: '502229******5995' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result).toEqual({
      verified: true,
      normalizedOutcome: 'VERIFIED',
      providerReference: AUTHORITY,
      externalEventId: '201534',
      alreadySettled: false,
      settledAmount: AMOUNT,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sandbox.zarinpal.com/pg/v4/payment/verify.json')
    expect(JSON.parse(init.body as string)).toEqual({
      merchant_id: 'merchant-uuid',
      authority: AUTHORITY,
      amount: 250_000,
    })
  })

  it('lets the settlement rule capture that confirmation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => success({ code: 100, ref_id: 201_534 })),
    )

    const evaluation = evaluateSettlement({
      expectedAmount: AMOUNT,
      expectedProviderReference: AUTHORITY,
      verification: await adapter.verifyCallback!(baseVerification()),
    })

    expect(evaluation.decision).toBe(SettlementDecision.SETTLE)
    expect(evaluation.settledAmount).toBe(AMOUNT)
  })

  it('marks code 101 as already settled so a repeated verify is not a second capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => success({ code: 101, ref_id: 201_534 })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.alreadySettled).toBe(true)
    expect(result.verified).toBe(true)
  })

  it('never settles an amount mismatch, and stops the attempt rather than retrying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-50)),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.verified).toBe(false)
    expect(result.normalizedOutcome).toBe('REJECTED')
    expect(result.reasonCode).toBe('ZARINPAL_VERIFY_NEG_50')
    expect(result.settledAmount).toBeUndefined()
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: AUTHORITY,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.REJECT)
  })

  it('reports an unpaid transaction as rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-51)),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.normalizedOutcome).toBe('REJECTED')
    expect(result.verified).toBe(false)
  })

  it('leaves an unclassified gateway error retryable rather than terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => failure(-52, 500)),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.normalizedOutcome).toBe('FAILED')
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: AUTHORITY,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.RETRY)
  })

  it('refuses to verify without an expected amount, because the amount is the evidence', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const withoutAmount = baseVerification()
    delete (withoutAmount as { expectedAmount?: bigint }).expectedAmount

    const result = await adapter.verifyCallback!(withoutAmount)

    expect(result).toEqual({
      verified: false,
      normalizedOutcome: 'FAILED',
      reasonCode: 'ZARINPAL_VERIFY_INPUT_MISSING',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to verify without an authority', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.verifyCallback!(baseVerification({ providerReference: '' }))

    expect(result.reasonCode).toBe('ZARINPAL_VERIFY_INPUT_MISSING')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreadable body as failed rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => new Response('<html>gateway down</html>', { status: 502 })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result).toEqual({
      verified: false,
      normalizedOutcome: 'FAILED',
      reasonCode: 'ZARINPAL_VERIFY_HTTP_502',
    })
  })
})
