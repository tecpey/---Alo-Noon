import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  evaluateSettlement,
  SettlementDecision,
  type ProviderVerificationInput,
} from '@alo-noon/domain'

import { createIdPayAdapter } from './idpay'
import { createNextPayAdapter } from './nextpay'
import { createShepaAdapter } from './shepa'
import { createZarinpalAdapter } from './zarinpal'

/**
 * Covers the settlement half of each gateway adapter: the server-to-server call
 * that decides whether a returning customer actually paid.
 *
 * The assertions run each adapter's answer through the same domain rule the
 * orchestrator uses, because what matters is not the shape of the reply but
 * whether it results in money moving.
 */
const EXPECTED_IRR = 2_950_000n

function credential(payload: Record<string, unknown> = { apiKey: 'test-api-key' }) {
  return { material: Buffer.from(JSON.stringify(payload), 'utf8'), dispose: vi.fn() }
}

function verificationInput(
  providerCode: string,
  overrides: Partial<ProviderVerificationInput> = {},
): ProviderVerificationInput {
  return {
    canonicalBody: new TextEncoder().encode('{}'),
    approvedHeaders: {},
    receivedAt: new Date('2026-08-07T10:00:00.000Z'),
    configuration: {
      id: 'config-1',
      tenantId: 'tenant-1',
      providerCode,
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
      merchantReference: 'merchant-1',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
      credentialReference: 'local-encrypted://TEST',
    },
    credential: credential(),
    providerReference: 'tx-1',
    paymentAttemptId: 'attempt-1',
    expectedAmount: EXPECTED_IRR,
    timeoutMs: 2_000,
    ...overrides,
  }
}

function stubGateway(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const idpay = createIdPayAdapter({ callbackUrl: 'https://alonoon.ir/cb/idpay' })
const nextpay = createNextPayAdapter({ callbackUrl: 'https://alonoon.ir/cb/nextpay' })
const shepa = createShepaAdapter({ callbackUrl: 'https://alonoon.ir/cb/shepa' })
// Zarinpal's own settlement behaviour is covered in zarinpal.test.ts; it appears
// here so the capability check below stays a check on *every* gateway.
const zarinpal = createZarinpalAdapter({ callbackUrl: 'https://alonoon.ir/cb/zarinpal' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('every gateway declares it can verify a callback', () => {
  it.each([
    ['IDPAY', idpay],
    ['NEXTPAY', nextpay],
    ['SHEPA', shepa],
    ['ZARINPAL', zarinpal],
  ])('%s', (_code, adapter) => {
    // The callback intake route only accepts a configuration carrying this
    // capability, so an adapter without it can never settle anything.
    expect(adapter.capabilities.has('CALLBACK_VERIFICATION')).toBe(true)
    expect(adapter.verifyCallback).toBeTypeOf('function')
  })
})

describe('IDPay settlement', () => {
  it('verifies against the id and order it started, and reports the Rial amount', async () => {
    const fetchMock = stubGateway(200, {
      status: 100,
      track_id: 'track-9',
      id: 'tx-1',
      amount: '2950000',
    })

    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))

    expect(result.verified).toBe(true)
    expect(result.settledAmount).toBe(EXPECTED_IRR)
    expect(result.externalEventId).toBe('track-9')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.idpay.ir/v1.1/payment/verify')
    // IDPay checks the pair, so sending both is what stops a reference from
    // another order verifying against this one.
    expect(JSON.parse(String(init.body))).toEqual({ id: 'tx-1', order_id: 'attempt-1' })
    expect((init.headers as Record<string, string>)['X-SANDBOX']).toBe('true')
  })

  it('treats "already verified" as settled, so a retry does not fail', async () => {
    stubGateway(200, { status: 101, track_id: 'track-9', id: 'tx-1', amount: '2950000' })
    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))
    expect(result.verified).toBe(true)
    expect(result.alreadySettled).toBe(true)
  })

  it.each([
    ['awaiting payment', 10, 'PENDING'],
    ['customer cancelled', 7, 'REJECTED'],
    ['payment failed', 2, 'FAILED'],
  ])('does not settle when IDPay reports %s', async (_label, status, outcome) => {
    stubGateway(200, { status, track_id: 'track-9' })
    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))
    expect(result.verified).toBe(false)
    expect(result.normalizedOutcome).toBe(outcome)
  })

  it('does not settle a success that carries no track id', async () => {
    stubGateway(200, { status: 100, amount: '2950000' })
    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))
    expect(result.verified).toBe(false)
  })

  it('reports no amount when IDPay sends an unparseable one', async () => {
    stubGateway(200, { status: 100, track_id: 'track-9', amount: '2,950,000' })
    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))
    expect(result.verified).toBe(true)
    expect(result.settledAmount).toBeUndefined()
    // Which the domain rule then refuses to capture on.
    expect(
      evaluateSettlement({
        expectedAmount: EXPECTED_IRR,
        expectedProviderReference: 'tx-1',
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.QUARANTINE)
  })

  it('does not call the gateway at all without a reference', async () => {
    const fetchMock = stubGateway(200, {})
    const input = verificationInput('IDPAY')
    delete input.providerReference
    const result = await idpay.verifyCallback!(input)
    expect(result.verified).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a network failure as unverified rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const result = await idpay.verifyCallback!(verificationInput('IDPAY'))
    expect(result.verified).toBe(false)
    expect(result.reasonCode).toBe('IDPAY_VERIFY_FAILED')
  })
})

describe('NextPay settlement', () => {
  it('sends Toman and converts the reported amount back to Rial', async () => {
    const fetchMock = stubGateway(200, { code: 0, amount: '295000', Shaparak_Ref_Id: 'shp-1' })

    const result = await nextpay.verifyCallback!(verificationInput('NEXTPAY'))

    expect(result.verified).toBe(true)
    // 295,000 Toman reported back is 2,950,000 Rial — the ledger's unit.
    expect(result.settledAmount).toBe(EXPECTED_IRR)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.nextpay.org/gateway/verify.http')
    const sent = new URLSearchParams(String(init.body))
    expect(sent.get('amount')).toBe('295000')
    expect(sent.get('trans_id')).toBe('tx-1')
  })

  it('settles on NextPay’s already-verified code', async () => {
    stubGateway(200, { code: -27, amount: '295000' })
    const result = await nextpay.verifyCallback!(verificationInput('NEXTPAY'))
    expect(result.verified).toBe(true)
    expect(result.alreadySettled).toBe(true)
  })

  it('does not settle on any other code', async () => {
    stubGateway(200, { code: -33 })
    const result = await nextpay.verifyCallback!(verificationInput('NEXTPAY'))
    expect(result.verified).toBe(false)
    expect(result.reasonCode).toBe('NEXTPAY_VERIFY_NEG33')
  })

  it('refuses an amount that cannot be expressed in Toman', async () => {
    // NextPay bills in Toman, so a Rial amount that is not a multiple of ten
    // cannot be verified at all — better to say so than to round it.
    const fetchMock = stubGateway(200, { code: 0 })
    const result = await nextpay.verifyCallback!(
      verificationInput('NEXTPAY', { expectedAmount: 2_950_005n }),
    )
    expect(result.verified).toBe(false)
    expect(result.reasonCode).toBe('NEXTPAY_VERIFY_REQUEST_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('quarantines a short settlement through the domain rule', async () => {
    // NextPay confirms, but for 1,000 Toman against a 2,950,000 Rial payment.
    stubGateway(200, { code: 0, amount: '1000' })
    const result = await nextpay.verifyCallback!(verificationInput('NEXTPAY'))
    expect(result.verified).toBe(true)
    expect(result.settledAmount).toBe(10_000n)
    expect(
      evaluateSettlement({
        expectedAmount: EXPECTED_IRR,
        expectedProviderReference: 'tx-1',
        verification: result,
      }).decision,
    ).toBe(SettlementDecision.QUARANTINE)
  })
})

describe('Shepa settlement', () => {
  it('verifies by token and reads the Rial amount back', async () => {
    const fetchMock = stubGateway(200, {
      success: true,
      result: { refid: 'ref-7', transaction_id: 'tid-7', amount: '2950000' },
    })

    const result = await shepa.verifyCallback!(verificationInput('SHEPA'))

    expect(result.verified).toBe(true)
    expect(result.settledAmount).toBe(EXPECTED_IRR)
    expect(result.externalEventId).toBe('ref-7')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // TEST configuration must reach the sandbox host, never production.
    expect(url).toBe('https://sandbox.shepa.com/api/v1/verify')
    expect(new URLSearchParams(String(init.body)).get('token')).toBe('tx-1')
  })

  it('uses the production host for a production configuration', async () => {
    const fetchMock = stubGateway(200, { success: true, result: { amount: '2950000' } })
    await shepa.verifyCallback!(
      verificationInput('SHEPA', {
        configuration: {
          ...verificationInput('SHEPA').configuration,
          environment: 'PRODUCTION',
        },
      }),
    )
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://merchant.shepa.com/api/v1/verify')
  })

  it('does not settle an unsuccessful response', async () => {
    stubGateway(200, { success: false, errorCode: 42 })
    const result = await shepa.verifyCallback!(verificationInput('SHEPA'))
    expect(result.verified).toBe(false)
    expect(result.reasonCode).toContain('SHEPA_VERIFY')
  })
})

describe('a settled answer only captures when it reconciles', () => {
  it('settles end to end for the exact amount', async () => {
    stubGateway(200, { status: 100, track_id: 'track-9', id: 'tx-1', amount: '2950000' })
    const verification = await idpay.verifyCallback!(verificationInput('IDPAY'))
    const decision = evaluateSettlement({
      expectedAmount: EXPECTED_IRR,
      expectedProviderReference: 'tx-1',
      verification,
    })
    expect(decision.decision).toBe(SettlementDecision.SETTLE)
    expect(decision.settledAmount).toBe(EXPECTED_IRR)
  })
})
