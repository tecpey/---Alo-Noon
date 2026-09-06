import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  formatBasisPoints,
  journalTotal,
  payoutJournal,
  settleOrder,
  settlementJournal,
  type OrderEconomics,
} from './settlement'

const order: OrderEconomics = {
  subtotal: 1_000_000n,
  deliveryFee: 200_000n,
  discount: 0n,
  total: 1_200_000n,
  commissionBasisPoints: 1_500,
  courierBasisPoints: 10_000,
}

describe('splitting a delivered order', () => {
  it('pays the bakery the bread less the commission', () => {
    const settlement = settleOrder(order)
    expect(settlement.commission).toBe(150_000n)
    expect(settlement.bakeryShare).toBe(850_000n)
    expect(settlement.bakeryShare + settlement.commission).toBe(order.subtotal)
  })

  it('pays the courier partner its agreed share of the fee', () => {
    expect(settleOrder(order).courierShare).toBe(200_000n)
    expect(settleOrder({ ...order, courierBasisPoints: 8_000 }).courierShare).toBe(160_000n)
    expect(settleOrder({ ...order, courierBasisPoints: 0 }).courierShare).toBe(0n)
  })

  /**
   * The remainder Rial goes to the bakery. A platform that rounds its own cut
   * up on every order has quietly given itself a raise nobody agreed to.
   */
  it('rounds the commission down, in the bakery’s favour', () => {
    const settlement = settleOrder({
      ...order,
      subtotal: 333_333n,
      total: 333_333n + 200_000n,
      commissionBasisPoints: 1_500,
    })
    // 333333 × 15% = 49999.95, and the platform takes 49999.
    expect(settlement.commission).toBe(49_999n)
    expect(settlement.bakeryShare).toBe(283_334n)
  })

  /**
   * A promotion the platform ran to fill a slow Tuesday is not something the
   * person who baked the bread agreed to fund.
   */
  it('charges a discount to the platform, never to the bakery', () => {
    const discounted = settleOrder({
      ...order,
      discount: 300_000n,
      total: 900_000n,
    })
    expect(discounted.bakeryShare).toBe(850_000n)
    expect(discounted.promotionCost).toBe(300_000n)
  })

  it('refuses a total that does not add up', () => {
    expect(() => settleOrder({ ...order, total: 999_999n })).toThrow(DomainError)
  })

  it('refuses an order nobody paid for', () => {
    expect(() =>
      settleOrder({ ...order, subtotal: 0n, deliveryFee: 0n, discount: 0n, total: 0n }),
    ).toThrow(DomainError)
  })

  it('refuses a rate that is not whole basis points in range', () => {
    expect(() => settleOrder({ ...order, commissionBasisPoints: 10_001 })).toThrow(DomainError)
    expect(() => settleOrder({ ...order, commissionBasisPoints: -1 })).toThrow(DomainError)
    expect(() => settleOrder({ ...order, courierBasisPoints: 15.5 })).toThrow(DomainError)
  })

  /** A month of orders, where a Number would already have drifted. */
  it('stays exact past the float-safe range', () => {
    const large = settleOrder({
      ...order,
      subtotal: 90_071_992_547_409_930n,
      deliveryFee: 0n,
      discount: 0n,
      total: 90_071_992_547_409_930n,
      commissionBasisPoints: 1_500,
    })
    expect(large.commission + large.bakeryShare).toBe(90_071_992_547_409_930n)
  })
})

describe('the settlement journal', () => {
  it('balances, and draws the clearing liability down by exactly what was paid', () => {
    const lines = settlementJournal(settleOrder(order), order.total)
    const debits = lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((total, line) => total + line.amount, 0n)
    const credits = lines
      .filter((line) => line.side === 'CREDIT')
      .reduce((total, line) => total + line.amount, 0n)

    expect(debits).toBe(credits)
    expect(
      lines.find((line) => line.accountCode === 'L_2100_PAYMENT_CLEARING' && line.side === 'DEBIT')
        ?.amount,
    ).toBe(order.total)
  })

  it('balances with a discount, where the platform funds the difference', () => {
    const discounted: OrderEconomics = { ...order, discount: 300_000n, total: 900_000n }
    const lines = settlementJournal(settleOrder(discounted), discounted.total)
    const debits = lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((total, line) => total + line.amount, 0n)
    const credits = lines
      .filter((line) => line.side === 'CREDIT')
      .reduce((total, line) => total + line.amount, 0n)

    expect(debits).toBe(credits)
    expect(lines.find((line) => line.accountCode === 'X_5300_PROMOTION')?.amount).toBe(300_000n)
  })

  /** A posting with an entry of nothing in it is a posting the database refuses. */
  it('drops the lines that would be zero', () => {
    const free: OrderEconomics = {
      ...order,
      deliveryFee: 0n,
      total: 1_000_000n,
      commissionBasisPoints: 0,
    }
    const codes = settlementJournal(settleOrder(free), free.total).map((line) => line.accountCode)
    expect(codes).not.toContain('R_4200_DELIVERY')
    expect(codes).not.toContain('X_5100_DELIVERY')
    expect(codes).not.toContain('R_4100_PRODUCT_SALES')
    expect(codes).toContain('L_2200_BAKERY_PAYABLE')
  })

  /**
   * The gross-up, stated as a fact rather than left for a posting site to
   * rediscover.
   *
   * A courier's ride is a cost the platform incurs *and* a debt it owes, so the
   * same amount appears on both sides of the journal and the total moved exceeds
   * what the customer paid. The ledger's balance check compares a posting's
   * headline amount against its debit side, so a caller that passed the order
   * total instead would have every delivered order refused — which is exactly
   * what happened before this existed.
   */
  it('reports the journal total as the debit side, not the order total', () => {
    const lines = settlementJournal(settleOrder(order), order.total)
    expect(journalTotal(lines)).toBe(order.total + 200_000n)
    expect(journalTotal(lines)).toBe(
      lines
        .filter((line) => line.side === 'CREDIT')
        .reduce((total, line) => total + line.amount, 0n),
    )
  })

  it('reports a payout journal at face value, because nothing about it grosses up', () => {
    expect(journalTotal(payoutJournal({ party: 'BAKERY', amount: 850_000n }))).toBe(850_000n)
  })

  it('never touches the customer wallet or cash', () => {
    const codes = settlementJournal(settleOrder(order), order.total).map((line) => line.accountCode)
    expect(codes).not.toContain('L_2400_CUSTOMER_WALLET')
    expect(codes).not.toContain('A_1100_CASH_CLEARING')
  })
})

describe('paying a partner', () => {
  /**
   * The mirror of the credit: the platform stops owing, and the money leaves
   * the bank. A payout is the only thing in this system that reduces cash.
   */
  it('discharges the payable against cash', () => {
    expect(payoutJournal({ party: 'BAKERY', amount: 850_000n })).toEqual([
      { accountCode: 'L_2200_BAKERY_PAYABLE', side: 'DEBIT', amount: 850_000n },
      { accountCode: 'A_1100_CASH_CLEARING', side: 'CREDIT', amount: 850_000n },
    ])
    expect(payoutJournal({ party: 'COURIER', amount: 1n })[0]?.accountCode).toBe(
      'L_2300_COURIER_PAYABLE',
    )
  })

  it('refuses to pay nothing', () => {
    expect(() => payoutJournal({ party: 'BAKERY', amount: 0n })).toThrow(DomainError)
    expect(() => payoutJournal({ party: 'BAKERY', amount: -1n })).toThrow(DomainError)
  })
})

describe('showing a rate to a person', () => {
  it('says the number that goes in the contract', () => {
    expect(formatBasisPoints(1_500)).toBe('۱۵٪')
    expect(formatBasisPoints(10_000)).toBe('۱۰۰٪')
    expect(formatBasisPoints(0)).toBe('۰٪')
  })

  it('keeps a fractional rate rather than rounding it away', () => {
    expect(formatBasisPoints(1_250)).toBe('۱۲٫۵۰٪')
    expect(formatBasisPoints(1_205)).toBe('۱۲٫۰۵٪')
  })
})
