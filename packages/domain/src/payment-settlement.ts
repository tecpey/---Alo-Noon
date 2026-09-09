import { DomainError } from './errors'
import type { ProviderVerificationResult } from './payment-provider'

/**
 * The rule that decides whether a gateway's answer is allowed to move money.
 *
 * This is deliberately a pure function in the domain, separate from the
 * orchestration that calls the gateway and writes to the database, because it is
 * the single point where a wrong answer costs real money. Everything it needs is
 * an argument; it reads no clock, no config, and no I/O.
 *
 * The decision is fail-closed in both directions. A gateway that says "yes" but
 * cannot say how much settles nothing. A gateway that says "yes" for the wrong
 * amount settles nothing — that is the classic attack, where a customer or a
 * tampered callback confirms a hundred-Rial transaction against a
 * million-Rial order, and it is the reason `settledAmount` is compared rather
 * than trusted.
 */
export const SettlementDecision = {
  /** Verified for the exact expected amount. The caller may capture. */
  SETTLE: 'SETTLE',
  /** The gateway is certain this payment did not succeed. Terminal. */
  REJECT: 'REJECT',
  /** No verdict yet. Leave the attempt alone and ask again later. */
  RETRY: 'RETRY',
  /**
   * The gateway answered, but its answer cannot be reconciled with what this
   * payment is for. Never captured, never silently dropped: a human has to look.
   */
  QUARANTINE: 'QUARANTINE',
} as const
export type SettlementDecision = (typeof SettlementDecision)[keyof typeof SettlementDecision]

export interface SettlementEvaluation {
  decision: SettlementDecision
  /** Stable, non-secret code recorded on the attempt and in the audit trail. */
  reasonCode: string
  /** Present only when the decision is SETTLE. */
  settledAmount?: bigint
}

export interface SettlementInput {
  /** What this payment is for, from our own record — never from the gateway. */
  expectedAmount: bigint
  /** The reference we recorded at initialization, if we have one. */
  expectedProviderReference: string | null
  verification: ProviderVerificationResult
}

const REASON = {
  settled: 'SETTLEMENT_CONFIRMED',
  alreadySettled: 'SETTLEMENT_ALREADY_CONFIRMED',
  rejected: 'SETTLEMENT_REJECTED_BY_PROVIDER',
  pending: 'SETTLEMENT_PENDING_AT_PROVIDER',
  failed: 'SETTLEMENT_PROVIDER_FAILED',
  amountMissing: 'SETTLEMENT_AMOUNT_NOT_REPORTED',
  amountMismatch: 'SETTLEMENT_AMOUNT_MISMATCH',
  referenceMismatch: 'SETTLEMENT_REFERENCE_MISMATCH',
} as const

export function evaluateSettlement(input: SettlementInput): SettlementEvaluation {
  if (input.expectedAmount <= 0n) {
    throw new DomainError(
      'INVALID_SETTLEMENT_INPUT',
      'Settlement evaluation requires a positive expected amount',
    )
  }
  const { verification } = input

  if (!verification.verified) {
    switch (verification.normalizedOutcome) {
      case 'REJECTED':
        return { decision: SettlementDecision.REJECT, reasonCode: REASON.rejected }
      case 'PENDING':
      case 'CUSTOMER_ACTION_REQUIRED':
        // The customer may still be at the gateway, or the gateway has not
        // settled yet. Neither is a failure, so the attempt keeps its state.
        return { decision: SettlementDecision.RETRY, reasonCode: REASON.pending }
      default:
        // FAILED and anything unrecognised: no verdict we can act on. Retrying
        // is safe because nothing has been captured.
        return { decision: SettlementDecision.RETRY, reasonCode: REASON.failed }
    }
  }

  // From here the gateway claims success, and every remaining check exists to
  // stop us acting on a claim we cannot reconcile.

  if (
    input.expectedProviderReference !== null &&
    verification.providerReference !== undefined &&
    verification.providerReference !== input.expectedProviderReference
  ) {
    // A success for a different transaction than the one this attempt started.
    // Capturing here would settle someone else's payment against this order.
    return { decision: SettlementDecision.QUARANTINE, reasonCode: REASON.referenceMismatch }
  }

  if (verification.settledAmount === undefined) {
    return { decision: SettlementDecision.QUARANTINE, reasonCode: REASON.amountMissing }
  }

  if (verification.settledAmount !== input.expectedAmount) {
    // Under-payment is the attack; over-payment is a reconciliation problem.
    // Neither may capture, and both need a human.
    return { decision: SettlementDecision.QUARANTINE, reasonCode: REASON.amountMismatch }
  }

  return {
    decision: SettlementDecision.SETTLE,
    reasonCode: verification.alreadySettled ? REASON.alreadySettled : REASON.settled,
    settledAmount: verification.settledAmount,
  }
}

/**
 * The journal for a captured payment, in the tenant's system chart.
 *
 * Cash arrives in a clearing asset account rather than being recognised as
 * revenue: at capture the money is with the gateway, not with us, and revenue is
 * not earned until the bread is delivered. Recognising revenue here would
 * overstate it for every order that is later cancelled or refunded, and would
 * make the payable to the bakery invisible until settlement.
 */
export interface CaptureJournalLine {
  accountCode: string
  side: 'DEBIT' | 'CREDIT'
  amount: bigint
}

export function captureJournal(amount: bigint): readonly CaptureJournalLine[] {
  if (amount <= 0n) {
    throw new DomainError('INVALID_SETTLEMENT_INPUT', 'Capture requires a positive amount')
  }
  return Object.freeze([
    { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount },
    { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount },
  ] satisfies CaptureJournalLine[])
}
