import { DomainError } from './errors'
import type { CaptureJournalLine } from './payment-settlement'

/**
 * A balance the customer charged, and what may move it.
 *
 * The rules here are short because they have to be. Every one of them is the
 * difference between a business that knows what it owes and one that does not,
 * and the place they are easiest to get wrong is a service method with four
 * other things on its mind.
 *
 * Amounts are always positive. Direction is carried by the kind, never by the
 * sign — a negative amount reaching a ledger is how a credit becomes a debit by
 * accident, and by then it is a reconciliation rather than a bug.
 */
export const WalletEntryKind = {
  /** Money arriving from a gateway. */
  TOP_UP: 'TOP_UP',
  /** A balance paying for an order. */
  ORDER_PAYMENT: 'ORDER_PAYMENT',
  /** A cancelled order giving the money back. */
  REFUND: 'REFUND',
  /** Somebody else's balance arriving. */
  TRANSFER_IN: 'TRANSFER_IN',
  /** This balance going to somebody else. */
  TRANSFER_OUT: 'TRANSFER_OUT',
} as const
export type WalletEntryKind = (typeof WalletEntryKind)[keyof typeof WalletEntryKind]

/** Which way each kind moves a balance. Exhaustive on purpose. */
const DIRECTIONS: Readonly<Record<WalletEntryKind, 'CREDIT' | 'DEBIT'>> = {
  TOP_UP: 'CREDIT',
  ORDER_PAYMENT: 'DEBIT',
  REFUND: 'CREDIT',
  TRANSFER_IN: 'CREDIT',
  TRANSFER_OUT: 'DEBIT',
}

export function walletEntryDirection(kind: WalletEntryKind): 'CREDIT' | 'DEBIT' {
  return DIRECTIONS[kind]
}

/**
 * The balance after one movement, or a refusal.
 *
 * Returns rather than throws for the one case a customer causes — spending more
 * than they have — because that is an answer the checkout has to show them, not
 * an exception. Everything else here is a programming error and throws.
 */
export type WalletMovement =
  | { readonly ok: true; readonly balanceAfter: bigint }
  | { readonly ok: false; readonly reason: 'INSUFFICIENT_BALANCE'; readonly shortfall: bigint }

export function applyWalletMovement(input: {
  readonly balance: bigint
  readonly kind: WalletEntryKind
  readonly amount: bigint
}): WalletMovement {
  if (input.amount <= 0n) {
    throw new DomainError('INVALID_WALLET_MOVEMENT', 'A wallet movement needs a positive amount')
  }
  if (input.balance < 0n) {
    throw new DomainError('INVALID_WALLET_MOVEMENT', 'A wallet balance cannot start negative')
  }

  if (walletEntryDirection(input.kind) === 'CREDIT') {
    return { ok: true, balanceAfter: input.balance + input.amount }
  }
  if (input.amount > input.balance) {
    // The shortfall, not just the refusal: "you need another ۴۰٬۰۰۰ ریال" is a
    // sentence a customer can act on, and "insufficient balance" is not.
    return { ok: false, reason: 'INSUFFICIENT_BALANCE', shortfall: input.amount - input.balance }
  }
  return { ok: true, balanceAfter: input.balance - input.amount }
}

const CASH_CLEARING_ACCOUNT = 'A_1100_CASH_CLEARING'
const PAYMENT_CLEARING_ACCOUNT = 'L_2100_PAYMENT_CLEARING'
export const CUSTOMER_WALLET_ACCOUNT = 'L_2400_CUSTOMER_WALLET'

/**
 * The journal for money arriving into a balance.
 *
 * The same debit a gateway capture makes — the cash is with us — against a
 * different credit. An order capture credits payment clearing because the
 * platform now owes a bakery a delivery; a top-up credits the customer wallet
 * because it owes the customer their money back. Crediting payment clearing
 * here would make a morning of top-ups look like a morning of orders.
 */
export function walletTopUpJournal(amount: bigint): readonly CaptureJournalLine[] {
  assertPositive(amount, 'A wallet top-up requires a positive amount')
  return Object.freeze([
    { accountCode: CASH_CLEARING_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: CUSTOMER_WALLET_ACCOUNT, side: 'CREDIT', amount },
  ] satisfies CaptureJournalLine[])
}

/**
 * The journal for a balance paying for an order.
 *
 * Nothing crosses the platform's edge, and that is the whole shape of it: one
 * obligation becomes another. The platform stops owing the customer a balance
 * and starts owing the bakery a delivery. Cash clearing is untouched, because
 * no cash moved — the money arrived when the wallet was charged.
 */
export function walletSpendJournal(amount: bigint): readonly CaptureJournalLine[] {
  assertPositive(amount, 'A wallet spend requires a positive amount')
  return Object.freeze([
    { accountCode: CUSTOMER_WALLET_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: PAYMENT_CLEARING_ACCOUNT, side: 'CREDIT', amount },
  ] satisfies CaptureJournalLine[])
}

/**
 * What a customer may add in one go.
 *
 * The floor keeps the gateway's per-transaction fee from swallowing the
 * top-up — under ten thousand Rial the platform pays more to accept the money
 * than the money is worth. The ceiling is not a fraud control, it is a
 * money-laundering one: a balance is transferable, so an unbounded top-up is an
 * unbounded way to move value between two people through a bakery.
 */
export const MINIMUM_TOP_UP = 100_000n
export const MAXIMUM_TOP_UP = 50_000_000n

export type TopUpRefusal = 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM'

export function validateTopUpAmount(amount: bigint): TopUpRefusal | undefined {
  if (amount < MINIMUM_TOP_UP) return 'BELOW_MINIMUM'
  if (amount > MAXIMUM_TOP_UP) return 'ABOVE_MAXIMUM'
  return undefined
}

/** Why a top-up was refused, in words a customer can act on. */
export function topUpRefusalMessage(refusal: TopUpRefusal): string {
  switch (refusal) {
    case 'BELOW_MINIMUM':
      return `کمترین مبلغ شارژ ${format(MINIMUM_TOP_UP)} ریال است.`
    case 'ABOVE_MAXIMUM':
      return `بیشترین مبلغ شارژ در هر بار ${format(MAXIMUM_TOP_UP)} ریال است.`
  }
}

function format(amount: bigint): string {
  return new Intl.NumberFormat('fa-IR').format(amount)
}

function assertPositive(amount: bigint, message: string): void {
  if (amount <= 0n) throw new DomainError('INVALID_WALLET_MOVEMENT', message)
}
