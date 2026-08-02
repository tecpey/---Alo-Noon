import { describe, expect, it } from 'vitest'

import {
  FinancialTransactionType,
  LedgerEntrySide,
  postDoubleEntry,
  type FinancialPosting,
} from './ledger'

const posting: FinancialPosting = {
  paymentId: 'payment-1',
  orderId: 'order-1',
  type: FinancialTransactionType.PAYMENT_CAPTURE,
  amount: 530_000n,
  currency: 'IRR',
  idempotencyKey: 'financial-command-0001',
  correlationId: 'correlation-1',
  occurredAt: new Date('2026-08-03T00:00:00.000Z'),
  lines: [
    { accountId: 'cash', side: LedgerEntrySide.DEBIT, amount: 530_000n, currency: 'IRR' },
    { accountId: 'clearing', side: LedgerEntrySide.CREDIT, amount: 530_000n, currency: 'IRR' },
  ],
}

describe('double-entry ledger', () => {
  it('posts balanced positive integer IRR lines', () => {
    expect(postDoubleEntry(posting)).toMatchObject({
      debitTotal: 530_000n,
      creditTotal: 530_000n,
    })
  })

  it('supports split entries while preserving the transaction amount', () => {
    expect(
      postDoubleEntry({
        ...posting,
        lines: [
          { accountId: 'cash', side: LedgerEntrySide.DEBIT, amount: 530_000n, currency: 'IRR' },
          {
            accountId: 'bakery-payable',
            side: LedgerEntrySide.CREDIT,
            amount: 480_000n,
            currency: 'IRR',
          },
          {
            accountId: 'delivery-revenue',
            side: LedgerEntrySide.CREDIT,
            amount: 50_000n,
            currency: 'IRR',
          },
        ],
      }).creditTotal,
    ).toBe(530_000n)
  })

  it.each([
    [[posting.lines[0]!], 'at least two lines'],
    [[posting.lines[0]!, { ...posting.lines[1]!, amount: 529_999n }], 'balance'],
    [[posting.lines[0]!, { ...posting.lines[1]!, accountId: 'cash' }], 'balance'],
  ] as const)('rejects invalid journal lines', (lines, message) => {
    expect(() => postDoubleEntry({ ...posting, lines })).toThrow(message)
  })

  it('rejects zero and negative financial values', () => {
    expect(() => postDoubleEntry({ ...posting, amount: 0n })).toThrow('invalid')
    expect(() =>
      postDoubleEntry({
        ...posting,
        lines: [{ ...posting.lines[0]!, amount: -1n }, posting.lines[1]!],
      }),
    ).toThrow('positive IRR')
  })
})
