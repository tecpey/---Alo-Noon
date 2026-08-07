import { describe, expect, it } from 'vitest'

import { captureJournal, evaluateSettlement, SettlementDecision } from './payment-settlement'
import type { ProviderVerificationResult } from './payment-provider'

const EXPECTED = 2_950_000n

function verification(
  overrides: Partial<ProviderVerificationResult> = {},
): ProviderVerificationResult {
  return {
    verified: true,
    normalizedOutcome: 'VERIFIED',
    providerReference: 'tx-1',
    settledAmount: EXPECTED,
    ...overrides,
  }
}

describe('settlement decision', () => {
  it('settles a verified payment for the exact expected amount', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification(),
    })
    expect(result.decision).toBe(SettlementDecision.SETTLE)
    expect(result.settledAmount).toBe(EXPECTED)
    expect(result.reasonCode).toBe('SETTLEMENT_CONFIRMED')
  })

  it('still settles when the gateway reports the reference was already settled', () => {
    // Iranian gateways answer a repeated verify with "already verified". That is
    // the reply that makes retry safe, so it must settle, not fail.
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ alreadySettled: true }),
    })
    expect(result.decision).toBe(SettlementDecision.SETTLE)
    expect(result.reasonCode).toBe('SETTLEMENT_ALREADY_CONFIRMED')
  })

  it('settles when we hold no reference of our own to compare against', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: null,
      verification: verification(),
    })
    expect(result.decision).toBe(SettlementDecision.SETTLE)
  })
})

describe('settlement refuses to capture what it cannot reconcile', () => {
  it('quarantines an under-payment rather than marking the order paid', () => {
    // The classic attack: confirm a small transaction against a large order.
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ settledAmount: 1_000n }),
    })
    expect(result.decision).toBe(SettlementDecision.QUARANTINE)
    expect(result.reasonCode).toBe('SETTLEMENT_AMOUNT_MISMATCH')
    expect(result.settledAmount).toBeUndefined()
  })

  it('quarantines an over-payment too', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ settledAmount: EXPECTED + 1n }),
    })
    expect(result.decision).toBe(SettlementDecision.QUARANTINE)
    expect(result.reasonCode).toBe('SETTLEMENT_AMOUNT_MISMATCH')
  })

  it('quarantines a success that reports no amount at all', () => {
    // A confirmation that cannot say how much proves nothing. The property is
    // omitted rather than set to undefined, which is what an adapter that could
    // not read an amount actually produces.
    const withoutAmount = { ...verification() }
    delete withoutAmount.settledAmount
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: withoutAmount,
    })
    expect(result.decision).toBe(SettlementDecision.QUARANTINE)
    expect(result.reasonCode).toBe('SETTLEMENT_AMOUNT_NOT_REPORTED')
  })

  it('quarantines a success carrying a different transaction reference', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ providerReference: 'tx-someone-else' }),
    })
    expect(result.decision).toBe(SettlementDecision.QUARANTINE)
    expect(result.reasonCode).toBe('SETTLEMENT_REFERENCE_MISMATCH')
  })

  it('checks the reference before the amount, so a swap is named for what it is', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ providerReference: 'tx-2', settledAmount: 1n }),
    })
    expect(result.reasonCode).toBe('SETTLEMENT_REFERENCE_MISMATCH')
  })
})

describe('settlement when the gateway has not confirmed', () => {
  it.each([
    ['PENDING', 'SETTLEMENT_PENDING_AT_PROVIDER'],
    ['CUSTOMER_ACTION_REQUIRED', 'SETTLEMENT_PENDING_AT_PROVIDER'],
    ['FAILED', 'SETTLEMENT_PROVIDER_FAILED'],
  ])('retries on %s', (outcome, reasonCode) => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({
        verified: false,
        normalizedOutcome: outcome as ProviderVerificationResult['normalizedOutcome'],
      }),
    })
    expect(result.decision).toBe(SettlementDecision.RETRY)
    expect(result.reasonCode).toBe(reasonCode)
  })

  it('rejects terminally when the gateway says the payment failed', () => {
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ verified: false, normalizedOutcome: 'REJECTED' }),
    })
    expect(result.decision).toBe(SettlementDecision.REJECT)
  })

  it('ignores an amount attached to an unverified answer', () => {
    // An adapter that fills in an amount while reporting failure must not be
    // able to smuggle a capture through.
    const result = evaluateSettlement({
      expectedAmount: EXPECTED,
      expectedProviderReference: 'tx-1',
      verification: verification({ verified: false, normalizedOutcome: 'REJECTED' }),
    })
    expect(result.decision).toBe(SettlementDecision.REJECT)
    expect(result.settledAmount).toBeUndefined()
  })
})

describe('settlement input validation', () => {
  it.each([[0n], [-1n]])('refuses a non-positive expected amount (%s)', (amount) => {
    expect(() =>
      evaluateSettlement({
        expectedAmount: amount,
        expectedProviderReference: null,
        verification: verification(),
      }),
    ).toThrow(/positive/)
  })
})

describe('capture journal', () => {
  it('balances into cash clearing against payment clearing', () => {
    const lines = captureJournal(EXPECTED)
    const debits = lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((total, line) => total + line.amount, 0n)
    const credits = lines
      .filter((line) => line.side === 'CREDIT')
      .reduce((total, line) => total + line.amount, 0n)
    expect(debits).toBe(EXPECTED)
    expect(credits).toBe(EXPECTED)
    expect(new Set(lines.map((line) => line.accountCode)).size).toBe(2)
  })

  it('does not recognise revenue at capture', () => {
    // The money is with the gateway and the bread is not delivered; recognising
    // revenue here overstates it for every order later cancelled or refunded.
    const codes = captureJournal(EXPECTED).map((line) => line.accountCode)
    expect(codes.some((code) => code.startsWith('R_'))).toBe(false)
  })

  it('refuses a non-positive amount', () => {
    expect(() => captureJournal(0n)).toThrow(/positive/)
  })
})
