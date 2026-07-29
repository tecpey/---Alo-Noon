import { DomainError } from './errors'

export type Currency = 'IRR' | 'USD'

export interface SerializedMoney {
  amount: string
  currency: Currency
}

export class Money {
  private constructor(
    public readonly amount: bigint,
    public readonly currency: Currency,
  ) {}

  static irr(amount: bigint | number | string): Money {
    return Money.from(amount, 'IRR')
  }

  static from(amount: bigint | number | string, currency: Currency): Money {
    let integerAmount: bigint
    try {
      integerAmount = BigInt(amount)
    } catch {
      throw new DomainError('INVALID_MONEY_AMOUNT', 'Money must be an integer minor-unit amount')
    }
    if (integerAmount < 0n) {
      throw new DomainError('INVALID_MONEY_AMOUNT', 'Money cannot be negative')
    }
    return new Money(integerAmount, currency)
  }

  add(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(this.amount + other.amount, this.currency)
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    if (other.amount > this.amount) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Money subtraction cannot produce a negative amount',
      )
    }
    return new Money(this.amount - other.amount, this.currency)
  }

  multiply(quantity: number): Money {
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Money quantity must be a non-negative safe integer',
      )
    }
    return new Money(this.amount * BigInt(quantity), this.currency)
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount
  }

  toJSON(): SerializedMoney {
    return { amount: this.amount.toString(), currency: this.currency }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money operations require matching currencies', {
        left: this.currency,
        right: other.currency,
      })
    }
  }
}
