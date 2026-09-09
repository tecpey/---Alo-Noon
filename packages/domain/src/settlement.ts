import { DomainError } from './errors'

/**
 * Who is owed what, once the bread is delivered.
 *
 * Until this exists, money arrives and stops. Capture credits payment clearing
 * and nothing draws it down but a refund — so the bakery that baked and the
 * courier who rode are owed nothing the books can see, and the liability the
 * platform is carrying grows with every order it completes.
 *
 * The split happens at delivery, not at payment. A platform that recognised
 * revenue when a customer paid would be booking earnings on bread that has not
 * left the oven, and would owe a bakery for an order it might yet cancel. The
 * moment the obligation is discharged is the moment there is something to
 * divide.
 *
 * Every rate is basis points and every amount is an integer of Rial. A
 * percentage held as a float is a rounding argument with a partner, once a
 * month, forever.
 */
export const BASIS_POINTS = 10_000n

export interface OrderEconomics {
  /** What the bread cost, before any discount. */
  readonly subtotal: bigint
  /** What the customer was charged to have it brought. */
  readonly deliveryFee: bigint
  /** What the platform took off, and therefore funded. */
  readonly discount: bigint
  /** What the customer actually paid: subtotal + deliveryFee − discount. */
  readonly total: bigint
  /** The platform's cut of the bread, in basis points. */
  readonly commissionBasisPoints: number
  /** The courier partner's cut of the delivery fee, in basis points. */
  readonly courierBasisPoints: number
}

export interface OrderSettlement {
  /** The platform's earning on the bread. */
  readonly commission: bigint
  /** What the bakery is owed: the bread minus that commission. */
  readonly bakeryShare: bigint
  /** What the courier partner is owed for the ride. */
  readonly courierShare: bigint
  /** The delivery fee, recognised as revenue in full. */
  readonly deliveryRevenue: bigint
  /** The discount, recognised as what it is: a cost the platform chose. */
  readonly promotionCost: bigint
}

export interface SettlementJournalLine {
  readonly accountCode: string
  readonly side: 'DEBIT' | 'CREDIT'
  readonly amount: bigint
}

const PAYMENT_CLEARING = 'L_2100_PAYMENT_CLEARING'
const BAKERY_PAYABLE = 'L_2200_BAKERY_PAYABLE'
const COURIER_PAYABLE = 'L_2300_COURIER_PAYABLE'
const PRODUCT_SALES = 'R_4100_PRODUCT_SALES'
const DELIVERY_REVENUE = 'R_4200_DELIVERY'
const DELIVERY_EXPENSE = 'X_5100_DELIVERY'
const PROMOTION_COST = 'X_5300_PROMOTION'
const CASH_CLEARING = 'A_1100_CASH_CLEARING'
const CUSTOMER_WALLET = 'L_2400_CUSTOMER_WALLET'

/**
 * Splits one delivered order.
 *
 * The commission rounds **down**, and that is a decision rather than an
 * accident: the remainder Rial goes to the bakery. A platform that rounds its
 * own cut up on every order is a platform that has quietly given itself a raise
 * nobody agreed to, and the argument it starts is not worth the money.
 *
 * The discount is the platform's cost, never the bakery's. A promotion the
 * platform ran to fill a slow Tuesday is not something the person who baked the
 * bread agreed to fund, and a partner who discovers otherwise stops being a
 * partner.
 */
export function settleOrder(order: OrderEconomics): OrderSettlement {
  assertWhole(order.subtotal, 'subtotal')
  assertWhole(order.deliveryFee, 'delivery fee')
  assertWhole(order.discount, 'discount')
  assertWhole(order.total, 'total')
  assertRate(order.commissionBasisPoints, 'commission')
  assertRate(order.courierBasisPoints, 'courier share')

  if (order.total !== order.subtotal + order.deliveryFee - order.discount) {
    throw new DomainError(
      'INVALID_SETTLEMENT',
      'An order total must equal its subtotal plus delivery minus discount',
    )
  }
  if (order.total <= 0n) {
    throw new DomainError('INVALID_SETTLEMENT', 'A settled order must have been paid for')
  }

  const commission = (order.subtotal * BigInt(order.commissionBasisPoints)) / BASIS_POINTS
  const courierShare = (order.deliveryFee * BigInt(order.courierBasisPoints)) / BASIS_POINTS

  return Object.freeze({
    commission,
    bakeryShare: order.subtotal - commission,
    courierShare,
    deliveryRevenue: order.deliveryFee,
    promotionCost: order.discount,
  })
}

/**
 * The journal that moves the money from "held" to "owed and earned".
 *
 * Reads as the sentence it is. The customer's money leaves clearing; the bakery
 * and the courier partner become creditors; the platform's commission and the
 * delivery fee become revenue; the ride and the discount become costs.
 *
 * Zero lines are dropped rather than posted. A free delivery with no courier
 * cost would otherwise put two lines of nothing into the ledger, and the
 * database refuses a posting with an entry of zero anyway.
 */
export function settlementJournal(
  settlement: OrderSettlement,
  total: bigint,
): readonly SettlementJournalLine[] {
  const lines: SettlementJournalLine[] = [
    { accountCode: PAYMENT_CLEARING, side: 'DEBIT', amount: total },
    { accountCode: DELIVERY_EXPENSE, side: 'DEBIT', amount: settlement.courierShare },
    { accountCode: PROMOTION_COST, side: 'DEBIT', amount: settlement.promotionCost },
    { accountCode: BAKERY_PAYABLE, side: 'CREDIT', amount: settlement.bakeryShare },
    { accountCode: COURIER_PAYABLE, side: 'CREDIT', amount: settlement.courierShare },
    { accountCode: PRODUCT_SALES, side: 'CREDIT', amount: settlement.commission },
    { accountCode: DELIVERY_REVENUE, side: 'CREDIT', amount: settlement.deliveryRevenue },
  ]
  const posted = lines.filter((line) => line.amount > 0n)

  const debits = sum(posted, 'DEBIT')
  const credits = sum(posted, 'CREDIT')
  if (debits !== credits) {
    // Unreachable if `settleOrder` produced the settlement, and worth checking
    // anyway: this is the one function in the system that can invent money.
    throw new DomainError('INVALID_SETTLEMENT', 'A settlement journal must balance')
  }
  return Object.freeze(posted)
}

/**
 * The gross value a journal moves: its debit side.
 *
 * Not the order total, and the difference is not a rounding detail. A delivered
 * order grosses up — the courier's ride is both a cost the platform incurs and a
 * debt it owes, so the same 9,600 Rial appears on both sides — and the posting's
 * headline amount has to be what the journal actually moved or the ledger's own
 * balance check refuses it. Callers pass this rather than recomputing the
 * gross-up at each posting site and getting it subtly different.
 */
export function journalTotal(lines: readonly SettlementJournalLine[]): bigint {
  return sum(lines, 'DEBIT')
}

/**
 * The journal that actually pays somebody.
 *
 * The mirror of the credit above: the platform stops owing a partner and the
 * money leaves the bank. Cash clearing is the account the gateway's money
 * landed in, which is the same money going out — this and a customer's
 * withdrawal below are the only two things in this system that reduce it.
 */
export function payoutJournal(input: {
  readonly party: 'BAKERY' | 'COURIER'
  readonly amount: bigint
}): readonly SettlementJournalLine[] {
  assertWhole(input.amount, 'payout')
  if (input.amount <= 0n) {
    throw new DomainError('INVALID_SETTLEMENT', 'A payout must be for a positive amount')
  }
  return Object.freeze([
    {
      accountCode: input.party === 'BAKERY' ? BAKERY_PAYABLE : COURIER_PAYABLE,
      side: 'DEBIT' as const,
      amount: input.amount,
    },
    { accountCode: CASH_CLEARING, side: 'CREDIT' as const, amount: input.amount },
  ])
}

/**
 * The journal that pays a customer's balance back to their card.
 *
 * The mirror of a top-up. A top-up moved money from the bank into what the
 * platform owes the customer; this moves it back out. Cash clearing is the same
 * account both times, because it is the same bank.
 *
 * Nothing here is about an order. A balance is what is left after a dozen of
 * them, or a top-up nobody spent, and by the time it goes out it is one number
 * owed to one person.
 */
export function withdrawalJournal(amount: bigint): readonly SettlementJournalLine[] {
  assertWhole(amount, 'withdrawal')
  if (amount <= 0n) {
    throw new DomainError('INVALID_SETTLEMENT', 'A withdrawal must be for a positive amount')
  }
  return Object.freeze([
    { accountCode: CUSTOMER_WALLET, side: 'DEBIT' as const, amount },
    { accountCode: CASH_CLEARING, side: 'CREDIT' as const, amount },
  ])
}

/**
 * A commission rate, as a rate a person would say out loud.
 *
 * Basis points are exact and unreadable. "۱۵٪" is what goes in a contract and
 * on a screen, and one place converting between them keeps the panel and the
 * partner agreement quoting the same number.
 */
export function formatBasisPoints(basisPoints: number): string {
  assertRate(basisPoints, 'rate')
  const whole = Math.floor(basisPoints / 100)
  const fraction = basisPoints % 100
  const digits = fraction === 0 ? String(whole) : `${whole}٫${String(fraction).padStart(2, '0')}`
  return `${digits.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!)}٪`
}

function sum(lines: readonly SettlementJournalLine[], side: 'DEBIT' | 'CREDIT'): bigint {
  return lines.filter((line) => line.side === side).reduce((total, line) => total + line.amount, 0n)
}

function assertWhole(amount: bigint, what: string): void {
  if (amount < 0n) {
    throw new DomainError('INVALID_SETTLEMENT', `A settlement ${what} cannot be negative`)
  }
}

function assertRate(basisPoints: number, what: string): void {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > Number(BASIS_POINTS)) {
    throw new DomainError(
      'INVALID_SETTLEMENT',
      `A settlement ${what} must be whole basis points between zero and ten thousand`,
    )
  }
}
