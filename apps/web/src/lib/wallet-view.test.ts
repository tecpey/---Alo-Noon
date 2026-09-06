import { describe, expect, it } from 'vitest'

import {
  balanceCovers,
  shortfallRial,
  suggestedTopUpRial,
  transferStateLabel,
  walletEntryDirection,
  walletEntryLabel,
  walletEntrySign,
  TOP_UP_PRESETS_TOMAN,
} from './wallet-view'

const KINDS = ['TOP_UP', 'ORDER_PAYMENT', 'REFUND', 'TRANSFER_IN', 'TRANSFER_OUT'] as const

describe('statement lines', () => {
  it('names every kind the API can send', () => {
    for (const kind of KINDS) {
      expect(walletEntryLabel(kind)).toMatch(/\S/)
    }
  })

  /**
   * The direction is the one thing that must not be wrong. A credit shown as a
   * debit makes the running total look like an error and the platform look like
   * it lost the money.
   */
  it('points each kind the way the money actually went', () => {
    expect(walletEntryDirection('TOP_UP')).toBe('IN')
    expect(walletEntryDirection('REFUND')).toBe('IN')
    expect(walletEntryDirection('TRANSFER_IN')).toBe('IN')
    expect(walletEntryDirection('ORDER_PAYMENT')).toBe('OUT')
    expect(walletEntryDirection('TRANSFER_OUT')).toBe('OUT')
  })

  /** A sign, not only a colour: colour is what a screenshot loses first. */
  it('signs each line', () => {
    expect(walletEntrySign('TOP_UP')).toBe('+')
    expect(walletEntrySign('ORDER_PAYMENT')).toBe('−')
  })

  it('names every transfer state', () => {
    for (const state of ['PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(transferStateLabel(state)).toMatch(/\S/)
    }
  })
})

describe('paying from the balance', () => {
  it('knows when the balance is enough', () => {
    expect(balanceCovers('500000', '500000')).toBe(true)
    expect(balanceCovers('500001', '500000')).toBe(true)
    expect(balanceCovers('499999', '500000')).toBe(false)
  })

  it('says exactly what is missing', () => {
    expect(shortfallRial('300000', '500000')).toBe(200_000n)
    expect(shortfallRial('500000', '500000')).toBeNull()
  })

  /** Past the float-safe range, where a Number would have drifted. */
  it('compares amounts a Number could not hold', () => {
    expect(balanceCovers('9007199254740993', '9007199254740992')).toBe(true)
    expect(shortfallRial('9007199254740992', '9007199254740993')).toBe(1n)
  })

  it('treats anything that is not a digit string as not enough', () => {
    expect(balanceCovers('', '500000')).toBe(false)
    expect(balanceCovers('۵۰۰۰۰۰', '500000')).toBe(false)
    expect(shortfallRial('abc', '500000')).toBeNull()
  })
})

describe('suggesting a top-up', () => {
  /**
   * Always up. A suggestion that lands one Toman short is a second trip to a
   * bank gateway, which is the whole thing the suggestion exists to avoid.
   */
  it('rounds up to a round number, never down', () => {
    expect(suggestedTopUpRial(1n)).toBe(100_000n)
    expect(suggestedTopUpRial(100_000n)).toBe(100_000n)
    expect(suggestedTopUpRial(100_001n)).toBe(200_000n)
    expect(suggestedTopUpRial(250_000n)).toBe(300_000n)
  })

  it('suggests something even when nothing is missing', () => {
    expect(suggestedTopUpRial(0n)).toBe(100_000n)
    expect(suggestedTopUpRial(-5n)).toBe(100_000n)
  })

  it('offers presets a person would actually pick', () => {
    expect(TOP_UP_PRESETS_TOMAN.length).toBeGreaterThan(2)
    expect([...TOP_UP_PRESETS_TOMAN]).toEqual([...TOP_UP_PRESETS_TOMAN].sort((a, b) => a - b))
    expect(TOP_UP_PRESETS_TOMAN.every((amount) => amount % 10_000 === 0)).toBe(true)
  })
})
