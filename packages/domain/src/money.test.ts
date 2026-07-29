import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { Money } from './money'

describe('Money', () => {
  it('uses exact bigint arithmetic and stable JSON snapshots', () => {
    const unitPrice = Money.irr('250000')
    const total = unitPrice.multiply(3).add(Money.irr(50_000))

    expect(total.toJSON()).toEqual({ amount: '800000', currency: 'IRR' })
    expect(total.subtract(Money.irr(50_000)).equals(Money.irr(750_000))).toBe(true)
  })

  it('rejects negative and non-integer amounts', () => {
    expect(() => Money.irr(-1)).toThrowError(DomainError)
    expect(() => Money.irr(1.5)).toThrowError(DomainError)
  })

  it('rejects arithmetic across currencies', () => {
    expect(() => Money.irr(100).add(Money.from(100, 'USD'))).toThrowError(DomainError)
  })
})
