import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  CUSTOMER_WALLET_ACCOUNT,
  MAXIMUM_TOP_UP,
  MINIMUM_TOP_UP,
  WalletEntryKind,
  applyWalletMovement,
  topUpRefusalMessage,
  validateTopUpAmount,
  walletEntryDirection,
  walletSpendJournal,
  walletTopUpJournal,
} from './wallet'

describe('applyWalletMovement', () => {
  it('adds a top-up to the balance', () => {
    expect(applyWalletMovement({ balance: 100n, kind: 'TOP_UP', amount: 50n })).toEqual({
      ok: true,
      balanceAfter: 150n,
    })
  })

  it('takes an order payment out of it', () => {
    expect(applyWalletMovement({ balance: 100n, kind: 'ORDER_PAYMENT', amount: 40n })).toEqual({
      ok: true,
      balanceAfter: 60n,
    })
  })

  it('spends the balance down to exactly nothing', () => {
    expect(applyWalletMovement({ balance: 100n, kind: 'ORDER_PAYMENT', amount: 100n })).toEqual({
      ok: true,
      balanceAfter: 0n,
    })
  })

  /**
   * The one refusal a customer causes, so it is a value rather than an
   * exception — checkout has to show it, and the shortfall is what makes it
   * actionable. "You need another forty thousand" is a sentence somebody can do
   * something about; "insufficient balance" is not.
   */
  it('refuses to overspend, and says by how much', () => {
    expect(applyWalletMovement({ balance: 100n, kind: 'ORDER_PAYMENT', amount: 140n })).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_BALANCE',
      shortfall: 40n,
    })
  })

  it('refuses to move nothing, or a negative amount', () => {
    expect(() => applyWalletMovement({ balance: 100n, kind: 'TOP_UP', amount: 0n })).toThrow(
      DomainError,
    )
    expect(() => applyWalletMovement({ balance: 100n, kind: 'TOP_UP', amount: -5n })).toThrow(
      DomainError,
    )
  })

  it('refuses to reason from a balance that is already impossible', () => {
    expect(() => applyWalletMovement({ balance: -1n, kind: 'TOP_UP', amount: 5n })).toThrow(
      DomainError,
    )
  })

  /**
   * Direction belongs to the kind. If a kind is ever added without deciding
   * which way it moves money, this is where that shows up rather than in a
   * balance that drifts.
   */
  it('knows which way every kind moves a balance', () => {
    for (const kind of Object.values(WalletEntryKind)) {
      expect(['CREDIT', 'DEBIT']).toContain(walletEntryDirection(kind))
    }
    expect(walletEntryDirection('TRANSFER_OUT')).toBe('DEBIT')
    expect(walletEntryDirection('TRANSFER_IN')).toBe('CREDIT')
    expect(walletEntryDirection('REFUND')).toBe('CREDIT')
  })
})

describe('wallet journals', () => {
  /**
   * A top-up and an order capture share a debit and differ in their credit,
   * and the difference is the point: one says the platform owes a customer
   * their money, the other says it owes a bakery a delivery. Crediting the same
   * account for both would make a morning of top-ups indistinguishable from a
   * morning of orders.
   */
  it('credits the customer, not the bakery, when money arrives', () => {
    expect(walletTopUpJournal(500n)).toEqual([
      { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: 500n },
      { accountCode: CUSTOMER_WALLET_ACCOUNT, side: 'CREDIT', amount: 500n },
    ])
  })

  /**
   * Nothing crosses the platform's edge when a balance buys bread. Touching
   * cash clearing here would count the same money twice — once when the wallet
   * was charged and once when it was spent.
   */
  it('moves an obligation rather than money when a balance pays', () => {
    expect(walletSpendJournal(500n)).toEqual([
      { accountCode: CUSTOMER_WALLET_ACCOUNT, side: 'DEBIT', amount: 500n },
      { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: 500n },
    ])
  })

  it('balances both ways', () => {
    for (const journal of [walletTopUpJournal(700n), walletSpendJournal(700n)]) {
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
    expect(() => walletTopUpJournal(0n)).toThrow(DomainError)
    expect(() => walletSpendJournal(-1n)).toThrow(DomainError)
  })
})

describe('validateTopUpAmount', () => {
  it('accepts an ordinary amount', () => {
    expect(validateTopUpAmount(1_000_000n)).toBeUndefined()
  })

  it('accepts exactly the bounds', () => {
    expect(validateTopUpAmount(MINIMUM_TOP_UP)).toBeUndefined()
    expect(validateTopUpAmount(MAXIMUM_TOP_UP)).toBeUndefined()
  })

  /** Under the floor the gateway's fee costs more than the money is worth. */
  it('refuses an amount too small to be worth accepting', () => {
    expect(validateTopUpAmount(MINIMUM_TOP_UP - 1n)).toBe('BELOW_MINIMUM')
  })

  /** A balance is transferable, so an unbounded top-up is an unbounded way to move value. */
  it('refuses an amount above the ceiling', () => {
    expect(validateTopUpAmount(MAXIMUM_TOP_UP + 1n)).toBe('ABOVE_MAXIMUM')
  })

  it('says the actual limit rather than that there is one', () => {
    expect(topUpRefusalMessage('BELOW_MINIMUM')).toContain('۱۰۰٬۰۰۰')
    expect(topUpRefusalMessage('ABOVE_MAXIMUM')).toContain('۵۰٬۰۰۰٬۰۰۰')
  })
})
