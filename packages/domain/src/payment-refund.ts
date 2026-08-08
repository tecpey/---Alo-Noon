import { DomainError } from './errors'
import { PaymentAggregateState } from './payment'

/**
 * Giving a customer their money back.
 *
 * This is the only direction money has ever been able to move out of the
 * system, and the rules are deliberately narrow. A refund is not a payment in
 * reverse that a machine can decide to make: it is a person deciding an order
 * will not be fulfilled and that the money should go back.
 *
 * The decision is a pure function for the same reason capture's is — it is a
 * rule that moves money, and it should be readable and testable without a
 * database, a clock, or a gateway.
 */
export const RefundDecision = {
  /** Send the money back and post the reversal. */
  REFUND: 'REFUND',
  /** Nothing to refund: nothing was ever captured. */
  NOTHING_TO_REFUND: 'NOTHING_TO_REFUND',
  /** Already given back. Repeating is safe and changes nothing. */
  ALREADY_REFUNDED: 'ALREADY_REFUNDED',
  /** A refusal that needs a human: the numbers do not agree. */
  QUARANTINE: 'QUARANTINE',
} as const
export type RefundDecision = (typeof RefundDecision)[keyof typeof RefundDecision]

export interface RefundInput {
  paymentState: PaymentAggregateState
  /** What was actually captured, from the payment aggregate. */
  capturedAmount: bigint
  /** What the operator asked to refund. */
  requestedAmount: bigint
}

export interface RefundEvaluation {
  decision: RefundDecision
  amount: bigint | null
  reasonCode: string
}

/**
 * Decides whether money goes back, and how much.
 *
 * Fail-closed, like settlement, and for the mirror-image reason: settlement
 * refuses to record money it cannot prove arrived, and this refuses to send
 * money it cannot prove is owed.
 *
 * Partial refunds are not supported. A partial refund needs a reason it is
 * partial — a delivery fee kept, one line cancelled — and none of that is
 * modelled yet. Accepting an arbitrary smaller number would let an operator
 * invent a refund policy by typing, and the amount would be unexplainable
 * afterwards. A request for anything other than the captured amount is
 * quarantined rather than quietly rounded to what is possible.
 */
export function evaluateRefund(input: RefundInput): RefundEvaluation {
  if (input.paymentState === PaymentAggregateState.REFUNDED) {
    // Idempotent on purpose: a retried refund must not send the money twice.
    return {
      decision: RefundDecision.ALREADY_REFUNDED,
      amount: null,
      reasonCode: 'ALREADY_REFUNDED',
    }
  }
  if (input.paymentState !== PaymentAggregateState.CAPTURED) {
    // Nothing was captured, so there is nothing to give back. Cancelling such
    // an order costs nothing, which is why this is not an error.
    return {
      decision: RefundDecision.NOTHING_TO_REFUND,
      amount: null,
      reasonCode: 'NOT_CAPTURED',
    }
  }
  if (input.capturedAmount <= 0n) {
    return {
      decision: RefundDecision.QUARANTINE,
      amount: null,
      reasonCode: 'CAPTURED_AMOUNT_INVALID',
    }
  }
  if (input.requestedAmount !== input.capturedAmount) {
    return {
      decision: RefundDecision.QUARANTINE,
      amount: null,
      reasonCode: 'PARTIAL_REFUND_UNSUPPORTED',
    }
  }
  return { decision: RefundDecision.REFUND, amount: input.capturedAmount, reasonCode: 'REFUNDED' }
}

export interface RefundJournalLine {
  accountCode: 'A_1100_CASH_CLEARING' | 'L_2100_PAYMENT_CLEARING'
  side: 'DEBIT' | 'CREDIT'
  amount: bigint
}

/**
 * The exact mirror of the capture journal.
 *
 * Capture debited cash clearing and credited the payment clearing liability; a
 * refund reverses both. Both postings are kept rather than netted away, so the
 * ledger shows money arriving and leaving instead of a transaction that appears
 * never to have happened.
 */
export function refundJournal(amount: bigint): readonly RefundJournalLine[] {
  if (amount <= 0n) {
    throw new DomainError('INVALID_REFUND_INPUT', 'Refund requires a positive amount')
  }
  return Object.freeze([
    { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'DEBIT', amount },
    { accountCode: 'A_1100_CASH_CLEARING', side: 'CREDIT', amount },
  ] satisfies RefundJournalLine[])
}
