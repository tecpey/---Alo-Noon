import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  evaluateSettlement,
  normalizeInitializationResult,
  SettlementDecision,
  type ProviderPaymentRequest,
  type ProviderVerificationInput,
} from '@alo-noon/domain'

import { createZibalAdapter } from './zibal'

const AMOUNT = 250_000n
const TRACK_ID = '3341234512'
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'

function credential(material: string) {
  return { material: Buffer.from(material, 'utf8'), dispose: vi.fn() }
}

const configuration = {
  id: 'config-1',
  tenantId: 'tenant-1',
  providerCode: 'ZIBAL',
  adapterVersion: '1.0.0',
  adapterSpiVersion: 1 as const,
  environment: 'TEST' as const,
  merchantReference: 'merchant-1',
  callbackPolicy: 'SIGNED_ONLY' as const,
  capabilities: ['PAYMENT_INITIALIZATION' as const],
  credentialReference: 'local-encrypted://zibal',
}

function baseRequest(overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest {
  return {
    paymentAttemptId: ATTEMPT_ID,
    amount: AMOUNT,
    currency: 'IRR',
    idempotencyKey: 'idem-1',
    requestFingerprint: 'fingerprint-1',
    timeoutMs: 5_000,
    configuration,
    credential: credential(JSON.stringify({ merchant: 'merchant-key' })),
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
    configuration,
    credential: credential(JSON.stringify({ merchant: 'merchant-key' })),
    providerReference: TRACK_ID,
    expectedAmount: AMOUNT,
    paymentAttemptId: ATTEMPT_ID,
    timeoutMs: 5_000,
    ...overrides,
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status })
}

const adapter = createZibalAdapter({
  callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback/zibal',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Zibal adapter status mapping', () => {
  it.each([
    ['100', 'VERIFIED'],
    ['201', 'VERIFIED'],
    ['202', 'REJECTED'],
    ['203', 'REJECTED'],
    ['102', 'FAILED'],
    ['not-a-code', 'FAILED'],
  ])('maps result %s to %s', (result, outcome) => {
    expect(adapter.mapProviderStatus(result)).toBe(outcome)
  })
})

describe('Zibal adapter initialization', () => {
  it('sends Rial and the attempt id, and redirects to the trackId it was given', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json({ result: 100, trackId: Number(TRACK_ID) }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(baseRequest())

    expect(result).toEqual({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: TRACK_ID,
      customerActionUrl: `https://gateway.zibal.ir/start/${TRACK_ID}`,
    })
    expect(() => normalizeInitializationResult(result, new Date())).not.toThrow()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gateway.zibal.ir/v1/request')
    expect(JSON.parse(init.body as string)).toEqual({
      merchant: 'merchant-key',
      amount: 250_000,
      callbackUrl: 'https://api.alonoon.ir/api/v1/payments/callback/zibal',
      description: 'پرداخت سفارش',
      orderId: ATTEMPT_ID,
    })
  })

  it('honours an endpoint origin override while keeping Zibal paths', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json({ result: 100, trackId: Number(TRACK_ID) }))
    vi.stubGlobal('fetch', fetchMock)

    const local = createZibalAdapter({
      callbackUrl: 'http://localhost:3001/api/v1/payments/callback/zibal',
      endpointOrigin: 'http://127.0.0.1:4181/',
    })
    const result = await local.initializePayment!(baseRequest())

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4181/v1/request')
    expect(result.customerActionUrl).toBe(`http://127.0.0.1:4181/start/${TRACK_ID}`)
  })

  it.each([
    [102, 'merchant not found'],
    [103, 'merchant inactive'],
    [105, 'amount below the gateway minimum'],
    [106, 'callback URL rejected'],
  ])('treats result %i (%s) as permanent so it is not retried', async (result) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result, message: 'خطا' })),
    )

    const outcome = await adapter.initializePayment!(baseRequest())

    expect(outcome.outcome).toBe('PERMANENT_FAILURE')
    expect(outcome.normalizedCode).toBe(`ZIBAL_REQUEST_${result}`)
    expect(() => normalizeInitializationResult(outcome, new Date())).not.toThrow()
  })

  it('leaves an unclassified result retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 999 })),
    )

    const result = await adapter.initializePayment!(baseRequest())

    expect(result.outcome).toBe('RETRYABLE_FAILURE')
    expect(result.normalizedCode).toBe('ZIBAL_REQUEST_999')
  })

  it('refuses a success that carries no trackId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 100 })),
    )

    expect((await adapter.initializePayment!(baseRequest())).outcome).toBe('RETRYABLE_FAILURE')
  })

  it('rejects a malformed credential without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ credential: credential(JSON.stringify({ apiKey: 'wrong-field' })) }),
    )

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('ZIBAL_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an amount JSON cannot carry exactly rather than sending it rounded', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.initializePayment!(
      baseRequest({ amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    )

    expect(result.normalizedCode).toBe('ZIBAL_AMOUNT_UNSUPPORTED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a network failure as retryable without leaking the underlying error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')))

    expect(await adapter.initializePayment!(baseRequest())).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      normalizedCode: 'ZIBAL_REQUEST_FAILED',
      customerMessageKey: 'payment.initialization_unavailable',
    })
  })
})

describe('Zibal adapter verification', () => {
  it('reports the amount the gateway says it took, and settles on it', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      json({
        result: 100,
        amount: 250_000,
        orderId: ATTEMPT_ID,
        refNumber: 445_566,
        cardNumber: '621986******0912',
        paidAt: '2026-08-26T09:01:00.000Z',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result).toEqual({
      verified: true,
      normalizedOutcome: 'VERIFIED',
      providerReference: TRACK_ID,
      externalEventId: '445566',
      alreadySettled: false,
      settledAmount: AMOUNT,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gateway.zibal.ir/v1/verify')
    // trackId goes back as a number, which is what both reference drivers send.
    expect(JSON.parse(init.body as string)).toEqual({
      merchant: 'merchant-key',
      trackId: 3_341_234_512,
    })

    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: TRACK_ID,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.SETTLE)
  })

  it('never settles when the gateway reports a smaller amount than the order', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json({ result: 100, amount: 1_000, orderId: ATTEMPT_ID, refNumber: 1 }),
        ),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.settledAmount).toBe(1_000n)
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: TRACK_ID,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.QUARANTINE)
  })

  it('refuses a reply about a different order, whatever it claims', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json({
          result: 100,
          amount: 250_000,
          orderId: '00000000-0000-4000-8000-000000000999',
          refNumber: 1,
        }),
      ),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result).toEqual({
      verified: false,
      normalizedOutcome: 'FAILED',
      reasonCode: 'ZIBAL_VERIFY_ORDER_MISMATCH',
    })
  })

  it('marks result 201 as already settled so a repeated verify is not a second capture', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json({ result: 201, amount: 250_000, orderId: ATTEMPT_ID, refNumber: 7 }),
        ),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.verified).toBe(true)
    expect(result.alreadySettled).toBe(true)
  })

  it('keeps the transaction status when an unpaid order is rejected', async () => {
    // status 3 is Zibal's "cancelled by the customer".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 202, status: 3 })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.normalizedOutcome).toBe('REJECTED')
    expect(result.reasonCode).toBe('ZIBAL_VERIFY_202_STATUS_3')
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: TRACK_ID,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.REJECT)
  })

  it('renders a negative transaction status without breaking the code shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 202, status: -2 })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.reasonCode).toBe('ZIBAL_VERIFY_202_STATUS_NEG_2')
  })

  it('leaves an unclassified result retryable rather than terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 999 })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.normalizedOutcome).toBe('FAILED')
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: TRACK_ID,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.RETRY)
  })

  it('refuses a reference that is not a Zibal trackId without calling the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.verifyCallback!(
      baseVerification({ providerReference: 'not-a-track-id' }),
    )

    expect(result.reasonCode).toBe('ZIBAL_REFERENCE_MISSING')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreadable body as failed rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => new Response('<html>gateway down</html>', { status: 502 })),
    )

    expect(await adapter.verifyCallback!(baseVerification())).toEqual({
      verified: false,
      normalizedOutcome: 'FAILED',
      reasonCode: 'ZIBAL_VERIFY_HTTP_502',
    })
  })

  it('settles nothing when the gateway confirms without an amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ result: 100, orderId: ATTEMPT_ID })),
    )

    const result = await adapter.verifyCallback!(baseVerification())

    expect(result.verified).toBe(true)
    expect(result.settledAmount).toBeUndefined()
    expect(
      evaluateSettlement({
        expectedAmount: AMOUNT,
        expectedProviderReference: TRACK_ID,
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.QUARANTINE)
  })
})
