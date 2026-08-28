import { DomainError } from './errors'
import type { CaptureJournalLine } from './payment-settlement'

/**
 * Paying the courier in cash, and the books that have to survive it.
 *
 * In this market cash is not a fallback — for a great many customers it is the
 * only way they will buy bread from a stranger's application, and a platform
 * that cannot take it is a platform half the city cannot use. So this is not a
 * convenience feature; at provincial scale it is most of the revenue.
 *
 * It is also the one payment path where the money never touches the platform's
 * bank. A courier takes a handful of notes at a door, and from that moment the
 * platform is owed that money *by the courier* — which is a completely
 * different fact from money sitting at a gateway, and posting it as though it
 * were the same is how a delivery business discovers, months later, that its
 * cash position was never real.
 *
 * Two postings, therefore, not one:
 *
 *   collection   DEBIT  courier cash receivable   CREDIT payment clearing
 *   remittance   DEBIT  cash clearing             CREDIT courier cash receivable
 *
 * The first says the order is paid and a courier is holding our money. The
 * second says the courier handed it in. Between them sits a number every
 * delivery business in the country needs on a whiteboard every evening: how
 * much cash is out on the road tonight, and with whom.
 */

/** How an order is paid for. */
export const PaymentMethod = {
  /** A bank gateway, redirect and callback. */
  ONLINE_GATEWAY: 'ONLINE_GATEWAY',
  /** Notes, at the door, into a courier's hand. */
  CASH_ON_DELIVERY: 'CASH_ON_DELIVERY',
} as const
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod]

/**
 * The asset account that holds what couriers owe the platform.
 *
 * Deliberately not cash clearing. Cash clearing means "money we can spend";
 * this means "money someone is carrying". Collapsing the two would make the
 * platform's cash position look healthy on an evening when every rial of it is
 * in twenty different jacket pockets.
 */
export const COURIER_CASH_RECEIVABLE_ACCOUNT = 'A_1200_COURIER_CASH_RECEIVABLE'
const CASH_CLEARING_ACCOUNT = 'A_1100_CASH_CLEARING'
const PAYMENT_CLEARING_ACCOUNT = 'L_2100_PAYMENT_CLEARING'

/** When a city will let an order be paid in cash. */
export interface CashOnDeliveryPolicy {
  readonly enabled: boolean
  /**
   * The most an order may be worth and still be payable in cash.
   *
   * A cap is not bureaucracy: an unpaid cash order is a total loss of the
   * bread, the fare and the courier's hour, and the loss scales with the
   * basket. Undefined means uncapped, which is a decision an operator should
   * have to make deliberately.
   */
  readonly ceilingAmount?: bigint
  /**
   * Completed orders a customer needs before cash is offered to them.
   *
   * The classic cash-on-delivery fraud is a first-time account ordering to an
   * address nobody answers. Zero lets anyone pay cash, which is the right
   * setting for a bakery that knows its neighbourhood and the wrong one for a
   * city launch.
   */
  readonly minimumCompletedOrders: number
}

export interface CashOnDeliveryContext {
  readonly orderTotal: bigint
  readonly customerCompletedOrders: number
}

/** Why cash was not offered. Each needs different words in front of a customer. */
export const CashOnDeliveryRefusal = {
  DISABLED: 'CASH_ON_DELIVERY_DISABLED',
  ABOVE_CEILING: 'CASH_ON_DELIVERY_ABOVE_CEILING',
  CUSTOMER_NOT_ESTABLISHED: 'CASH_ON_DELIVERY_CUSTOMER_NOT_ESTABLISHED',
} as const
export type CashOnDeliveryRefusal =
  (typeof CashOnDeliveryRefusal)[keyof typeof CashOnDeliveryRefusal]

export type CashOnDeliveryDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: CashOnDeliveryRefusal }

/**
 * Whether this order, for this customer, may be paid in cash.
 *
 * Checked in the order an operator would explain it: the city does not offer
 * it, or the basket is too big to risk, or this customer has not bought
 * anything yet. A customer refused for being new should be told that, not told
 * their basket is too large.
 */
export function evaluateCashOnDelivery(
  policy: CashOnDeliveryPolicy,
  context: CashOnDeliveryContext,
): CashOnDeliveryDecision {
  if (!policy.enabled) {
    return { allowed: false, reason: CashOnDeliveryRefusal.DISABLED }
  }
  if (context.customerCompletedOrders < policy.minimumCompletedOrders) {
    return { allowed: false, reason: CashOnDeliveryRefusal.CUSTOMER_NOT_ESTABLISHED }
  }
  if (policy.ceilingAmount !== undefined && context.orderTotal > policy.ceilingAmount) {
    return { allowed: false, reason: CashOnDeliveryRefusal.ABOVE_CEILING }
  }
  return { allowed: true }
}

/**
 * The journal for cash taken at the door.
 *
 * Mirrors a gateway capture on the credit side — the order is paid either way,
 * and everything downstream that reads payment clearing must not have to know
 * how the money arrived. Only the debit differs, and it is the whole point: the
 * asset the platform now holds is a claim on a courier, not a balance at a
 * bank.
 */
export function cashCollectionJournal(amount: bigint): readonly CaptureJournalLine[] {
  assertPositive(amount, 'Cash collection requires a positive amount')
  return Object.freeze([
    { accountCode: COURIER_CASH_RECEIVABLE_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: PAYMENT_CLEARING_ACCOUNT, side: 'CREDIT', amount },
  ] satisfies CaptureJournalLine[])
}

/**
 * The journal for cash a courier hands in.
 *
 * This is the posting that finally makes the money real, and it is why
 * collection alone is not enough: a platform that only ever posted collections
 * would show an asset that grows forever and a bank balance that never moves.
 */
export function cashRemittanceJournal(amount: bigint): readonly CaptureJournalLine[] {
  assertPositive(amount, 'Cash remittance requires a positive amount')
  return Object.freeze([
    { accountCode: CASH_CLEARING_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: COURIER_CASH_RECEIVABLE_ACCOUNT, side: 'CREDIT', amount },
  ] satisfies CaptureJournalLine[])
}

/**
 * What a courier owes for a set of orders, and whether the count they handed in
 * matches it.
 *
 * A remittance is exact or it is not a remittance. The amount is derived from
 * the orders being settled rather than typed in, and a courier who is short has
 * a dispute — which is a conversation, a deduction from their fee, or a
 * dismissal, and in every case a decision a person makes and records. Absorbing
 * a shortfall silently into the ledger would let cash leak out of the business
 * through a hole that balances perfectly.
 */
export function reconcileRemittance(input: {
  readonly orderAmounts: readonly bigint[]
  readonly declaredAmount: bigint
}): {
  readonly expectedAmount: bigint
  readonly balanced: boolean
  readonly varianceAmount: bigint
} {
  if (input.orderAmounts.length === 0) {
    throw new DomainError('INVALID_CASH_REMITTANCE', 'A remittance must settle at least one order')
  }
  let expectedAmount = 0n
  for (const amount of input.orderAmounts) {
    assertPositive(amount, 'A remitted order must be worth something')
    expectedAmount += amount
  }
  const varianceAmount = input.declaredAmount - expectedAmount
  return { expectedAmount, balanced: varianceAmount === 0n, varianceAmount }
}

function assertPositive(amount: bigint, message: string): void {
  if (amount <= 0n) {
    throw new DomainError('INVALID_CASH_REMITTANCE', message, { amount: amount.toString() })
  }
}
