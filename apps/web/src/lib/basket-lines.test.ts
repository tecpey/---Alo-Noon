import { describe, expect, it } from 'vitest'

import type { CartSummary } from '@alo-noon/contracts'

import { linesFromCart, mergePlan, parseStoredBasket, serializeBasket } from './basket-lines'

describe('parseStoredBasket', () => {
  it('reads a basket it wrote itself', () => {
    const raw = serializeBasket(new Map([['offering-a', 2]]))
    expect(parseStoredBasket(raw)).toEqual([{ offeringId: 'offering-a', quantity: 2 }])
  })

  it('is empty when nothing is stored', () => {
    expect(parseStoredBasket(null)).toEqual([])
    expect(parseStoredBasket('')).toEqual([])
  })

  /**
   * Everything below is a value that can genuinely arrive: an older release's
   * format, a truncated write, or a person editing local storage by hand. None
   * of it may become a basket line.
   */
  it('drops anything that is not a basket', () => {
    expect(parseStoredBasket('not json')).toEqual([])
    expect(parseStoredBasket('{"offeringId":"a"}')).toEqual([])
    expect(parseStoredBasket('null')).toEqual([])
    expect(parseStoredBasket('[1,2,3]')).toEqual([])
  })

  it('drops lines with an unusable quantity rather than repairing them', () => {
    const raw = JSON.stringify([
      { offeringId: 'ok', quantity: 3 },
      { offeringId: 'zero', quantity: 0 },
      { offeringId: 'negative', quantity: -5 },
      { offeringId: 'fractional', quantity: 1.5 },
      { offeringId: 'huge', quantity: 10_000 },
      { offeringId: 'text', quantity: '2' },
      { offeringId: '', quantity: 1 },
    ])
    expect(parseStoredBasket(raw)).toEqual([{ offeringId: 'ok', quantity: 3 }])
  })

  it('keeps one line per bread, so a repeated entry cannot inflate a quantity', () => {
    const raw = JSON.stringify([
      { offeringId: 'a', quantity: 100 },
      { offeringId: 'a', quantity: 100 },
    ])
    expect(parseStoredBasket(raw)).toEqual([{ offeringId: 'a', quantity: 100 }])
  })
})

describe('linesFromCart', () => {
  it('is empty for a customer with no cart', () => {
    expect([...linesFromCart(null)]).toEqual([])
  })

  it('keys the lines on the offering, matching the local basket', () => {
    const cart = {
      items: [
        { bakeryProductOfferingId: 'offering-a', quantity: 2 },
        { bakeryProductOfferingId: 'offering-b', quantity: 1 },
      ],
    } as CartSummary
    expect([...linesFromCart(cart)]).toEqual([
      ['offering-a', 2],
      ['offering-b', 1],
    ])
  })
})

describe('mergePlan', () => {
  it('writes nothing when the visitor signs in empty-handed', () => {
    expect(mergePlan(new Map(), new Map([['a', 2]]))).toEqual([])
  })

  it('carries a new bread onto the server cart', () => {
    expect(mergePlan(new Map([['a', 2]]), new Map())).toEqual([{ offeringId: 'a', quantity: 2 }])
  })

  /**
   * Two lavash left in a cart last week and two put in this tab means two, not
   * four. A merge that adds is a merge that turns into a refund.
   */
  it('takes the larger of the two quantities, never the sum', () => {
    expect(mergePlan(new Map([['a', 2]]), new Map([['a', 3]]))).toEqual([])
    expect(mergePlan(new Map([['a', 5]]), new Map([['a', 3]]))).toEqual([
      { offeringId: 'a', quantity: 5 },
    ])
  })

  it('is idempotent, so a retried sign-in cannot keep growing the cart', () => {
    const local = new Map([['a', 4]])
    const first = mergePlan(local, new Map())
    const server = new Map(first.map((line) => [line.offeringId, line.quantity]))
    expect(mergePlan(local, server)).toEqual([])
  })

  it('never proposes a quantity the API would refuse', () => {
    expect(mergePlan(new Map([['a', 100]]), new Map([['a', 100]]))).toEqual([])
  })
})
