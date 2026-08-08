import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { PaymentAggregateState } from './payment'
import { evaluateRefund, refundJournal, RefundDecision } from './payment-refund'

/**
 * The refund rule is fail-closed in the mirror image of settlement: it refuses
 * to send money it cannot prove is owed. These are the cases where getting it
 * wrong means either paying someone twice or refusing someone their money.
 */
describe('refund evaluation', () => {
  const captured = (requestedAmount: bigint) =>
    evaluateRefund({
      paymentState: PaymentAggregateState.CAPTURED,
      capturedAmount: 250_000n,
      requestedAmount,
    })

  it('refunds exactly what was captured', () => {
    expect(captured(250_000n)).toEqual({
      decision: RefundDecision.REFUND,
      amount: 250_000n,
      reasonCode: 'REFUNDED',
    })
  })

  it('quarantines a partial refund rather than inventing a policy', () => {
    // A partial refund needs a reason it is partial, and none is modelled. A
    // smaller number accepted here would be unexplainable afterwards.
    expect(captured(100_000n).decision).toBe(RefundDecision.QUARANTINE)
    expect(captured(100_000n).reasonCode).toBe('PARTIAL_REFUND_UNSUPPORTED')
  })

  it('quarantines a refund larger than the capture', () => {
    // The direction that actually loses money.
    expect(captured(400_000n).decision).toBe(RefundDecision.QUARANTINE)
  })

  it('is idempotent once refunded, so a retry cannot pay twice', () => {
    const again = evaluateRefund({
      paymentState: PaymentAggregateState.REFUNDED,
      capturedAmount: 250_000n,
      requestedAmount: 250_000n,
    })
    expect(again.decision).toBe(RefundDecision.ALREADY_REFUNDED)
    expect(again.amount).toBeNull()
  })

  it.each([
    PaymentAggregateState.CREATED,
    PaymentAggregateState.PENDING,
    PaymentAggregateState.AUTHORIZED,
    PaymentAggregateState.FAILED,
  ])('has nothing to refund from %s', (paymentState) => {
    // Cancelling an order nobody paid for costs nothing, so this is not an
    // error — the caller carries on and cancels.
    const result = evaluateRefund({
      paymentState,
      capturedAmount: 0n,
      requestedAmount: 250_000n,
    })
    expect(result.decision).toBe(RefundDecision.NOTHING_TO_REFUND)
    expect(result.amount).toBeNull()
  })

  it('quarantines a captured payment whose amount makes no sense', () => {
    const result = evaluateRefund({
      paymentState: PaymentAggregateState.CAPTURED,
      capturedAmount: 0n,
      requestedAmount: 0n,
    })
    expect(result.decision).toBe(RefundDecision.QUARANTINE)
    expect(result.reasonCode).toBe('CAPTURED_AMOUNT_INVALID')
  })
})

describe('refund journal', () => {
  it('mirrors the capture exactly', () => {
    expect(refundJournal(250_000n)).toEqual([
      { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'DEBIT', amount: 250_000n },
      { accountCode: 'A_1100_CASH_CLEARING', side: 'CREDIT', amount: 250_000n },
    ])
  })

  it('balances', () => {
    const lines = refundJournal(9_007_199_254_740_993n)
    const debits = lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((sum, line) => sum + line.amount, 0n)
    const credits = lines
      .filter((line) => line.side === 'CREDIT')
      .reduce((sum, line) => sum + line.amount, 0n)
    expect(debits).toBe(credits)
    // Beyond the float-safe range, where a Number would have drifted.
    expect(Number(debits)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
  })

  it('refuses a non-positive amount', () => {
    expect(() => refundJournal(0n)).toThrow(DomainError)
    expect(() => refundJournal(-1n)).toThrow(DomainError)
  })

  it('never touches revenue', () => {
    // Revenue was never recognised at capture, so there is none to reverse.
    const codes = refundJournal(250_000n).map((line) => line.accountCode)
    expect(codes.every((code) => !code.startsWith('R_'))).toBe(true)
  })
})
