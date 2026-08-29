import { describe, expect, it } from 'vitest'

import {
  CashOnDeliveryRefusal,
  COURIER_CASH_RECEIVABLE_ACCOUNT,
  PaymentMethod,
  cashCollectionJournal,
  cashRefusalMessage,
  cashRemittanceJournal,
  evaluateCashOnDelivery,
  reconcileRemittance,
  type CashOnDeliveryPolicy,
} from './cash-on-delivery'
import { DomainError } from './errors'
import { captureJournal } from './payment-settlement'

function policy(overrides: Partial<CashOnDeliveryPolicy> = {}): CashOnDeliveryPolicy {
  return { enabled: true, minimumCompletedOrders: 0, ...overrides }
}

describe('evaluateCashOnDelivery', () => {
  it('lets an ordinary basket be paid in cash', () => {
    expect(
      evaluateCashOnDelivery(policy(), { orderTotal: 400_000n, customerCompletedOrders: 0 }),
    ).toEqual({ allowed: true })
  })

  it('refuses when the city does not offer cash', () => {
    expect(
      evaluateCashOnDelivery(policy({ enabled: false }), {
        orderTotal: 400_000n,
        customerCompletedOrders: 10,
      }),
    ).toEqual({ allowed: false, reason: CashOnDeliveryRefusal.DISABLED })
  })

  /**
   * An unpaid cash order loses the bread, the fare and the courier's hour, and
   * the loss scales with the basket. The ceiling is the only thing bounding it.
   */
  it('refuses a basket above the ceiling, and allows one exactly at it', () => {
    const capped = policy({ ceilingAmount: 2_000_000n })
    expect(
      evaluateCashOnDelivery(capped, { orderTotal: 2_000_001n, customerCompletedOrders: 5 }),
    ).toEqual({ allowed: false, reason: CashOnDeliveryRefusal.ABOVE_CEILING })
    expect(
      evaluateCashOnDelivery(capped, { orderTotal: 2_000_000n, customerCompletedOrders: 5 })
        .allowed,
    ).toBe(true)
  })

  it('treats no ceiling as uncapped', () => {
    expect(
      evaluateCashOnDelivery(policy(), {
        orderTotal: 90_000_000n,
        customerCompletedOrders: 0,
      }).allowed,
    ).toBe(true)
  })

  /**
   * The classic cash-on-delivery fraud is a brand new account ordering to an
   * address nobody answers.
   */
  it('keeps cash away from a customer who has never completed an order', () => {
    const established = policy({ minimumCompletedOrders: 1 })
    expect(
      evaluateCashOnDelivery(established, { orderTotal: 100_000n, customerCompletedOrders: 0 }),
    ).toEqual({ allowed: false, reason: CashOnDeliveryRefusal.CUSTOMER_NOT_ESTABLISHED })
    expect(
      evaluateCashOnDelivery(established, { orderTotal: 100_000n, customerCompletedOrders: 1 })
        .allowed,
    ).toBe(true)
  })

  /**
   * A new customer with a large basket is refused for being new, not for the
   * basket — the two refusals send them to different next steps, and only one
   * of them is "buy less bread".
   */
  it('reports being new before it reports the basket', () => {
    expect(
      evaluateCashOnDelivery(policy({ minimumCompletedOrders: 2, ceilingAmount: 100_000n }), {
        orderTotal: 900_000n,
        customerCompletedOrders: 0,
      }),
    ).toEqual({ allowed: false, reason: CashOnDeliveryRefusal.CUSTOMER_NOT_ESTABLISHED })
  })
})

describe('the cash journals', () => {
  /**
   * The debit is the whole point. Cash clearing means "money we can spend";
   * a courier receivable means "money someone is carrying". Collapsing them
   * makes the platform's cash position look healthy on an evening when every
   * rial of it is in twenty different jacket pockets.
   */
  it('debits a courier receivable rather than cash', () => {
    expect(cashCollectionJournal(500_000n)).toEqual([
      { accountCode: COURIER_CASH_RECEIVABLE_ACCOUNT, side: 'DEBIT', amount: 500_000n },
      { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: 500_000n },
    ])
  })

  /**
   * The credit side has to match a gateway capture exactly. Everything
   * downstream reads payment clearing, and it must not have to know how the
   * money arrived.
   */
  it('credits the same account a gateway capture does', () => {
    const cash = cashCollectionJournal(500_000n)
    const gateway = captureJournal(500_000n)
    expect(cash.find((line) => line.side === 'CREDIT')).toEqual(
      gateway.find((line) => line.side === 'CREDIT'),
    )
  })

  it('moves the money to the bank when the courier hands it in', () => {
    expect(cashRemittanceJournal(500_000n)).toEqual([
      { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: 500_000n },
      { accountCode: COURIER_CASH_RECEIVABLE_ACCOUNT, side: 'CREDIT', amount: 500_000n },
    ])
  })

  /** Collection then remittance leaves the receivable flat: the courier is clear. */
  it('nets the receivable to nothing across both postings', () => {
    const net = [...cashCollectionJournal(500_000n), ...cashRemittanceJournal(500_000n)]
      .filter((line) => line.accountCode === COURIER_CASH_RECEIVABLE_ACCOUNT)
      .reduce((total, line) => total + (line.side === 'DEBIT' ? line.amount : -line.amount), 0n)
    expect(net).toBe(0n)
  })

  it('every posting balances', () => {
    for (const journal of [cashCollectionJournal(123_456n), cashRemittanceJournal(123_456n)]) {
      const debits = journal
        .filter((line) => line.side === 'DEBIT')
        .reduce((total, line) => total + line.amount, 0n)
      const credits = journal
        .filter((line) => line.side === 'CREDIT')
        .reduce((total, line) => total + line.amount, 0n)
      expect(debits).toBe(credits)
    }
  })

  it('refuses to post nothing', () => {
    expect(() => cashCollectionJournal(0n)).toThrow(DomainError)
    expect(() => cashRemittanceJournal(-1n)).toThrow(DomainError)
  })
})

describe('reconcileRemittance', () => {
  it('adds up the orders being settled', () => {
    expect(
      reconcileRemittance({
        orderAmounts: [400_000n, 350_000n, 250_000n],
        declaredAmount: 1_000_000n,
      }),
    ).toEqual({ expectedAmount: 1_000_000n, balanced: true, varianceAmount: 0n })
  })

  /**
   * A courier who is short has a dispute, which is a decision a person makes
   * and records. Absorbing it into the ledger would let cash leak out of the
   * business through a hole that balances perfectly.
   */
  it('reports a shortfall rather than swallowing it', () => {
    const result = reconcileRemittance({
      orderAmounts: [400_000n, 350_000n],
      declaredAmount: 700_000n,
    })
    expect(result.balanced).toBe(false)
    expect(result.varianceAmount).toBe(-50_000n)
  })

  it('reports an overpayment too', () => {
    expect(
      reconcileRemittance({ orderAmounts: [400_000n], declaredAmount: 450_000n }).varianceAmount,
    ).toBe(50_000n)
  })

  it('refuses a remittance that settles nothing', () => {
    expect(() => reconcileRemittance({ orderAmounts: [], declaredAmount: 0n })).toThrow(DomainError)
  })

  it('refuses an order worth nothing', () => {
    expect(() => reconcileRemittance({ orderAmounts: [0n], declaredAmount: 0n })).toThrow(
      DomainError,
    )
  })
})

describe('PaymentMethod', () => {
  it('names both ways an order can be paid for', () => {
    expect(Object.values(PaymentMethod)).toEqual(['ONLINE_GATEWAY', 'CASH_ON_DELIVERY'])
  })
})

describe('cashRefusalMessage', () => {
  /**
   * The point of three refusals is three different next steps. If two of them
   * ever collapse onto the same sentence, a customer who could pay cash by
   * ordering once through the gateway gets told the city does not offer it.
   */
  it('gives every refusal its own answer', () => {
    const messages = Object.values(CashOnDeliveryRefusal).map(cashRefusalMessage)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('never leaves a refusal speaking its code', () => {
    for (const reason of Object.values(CashOnDeliveryRefusal)) {
      expect(cashRefusalMessage(reason)).not.toContain('CASH_ON_DELIVERY')
    }
  })

  it('still says something when the API grows a refusal this does not know', () => {
    expect(cashRefusalMessage('CASH_ON_DELIVERY_SOMETHING_NEW')).toBe(
      'پرداخت نقدی برای این سفارش ممکن نیست.',
    )
  })
})
