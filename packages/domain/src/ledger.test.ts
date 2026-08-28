import { describe, expect, it } from 'vitest'

import {
  FinancialTransactionType,
  governLedgerAccount,
  LedgerEntrySide,
  postDoubleEntry,
  SYSTEM_CHART_VERSION,
  SYSTEM_LEDGER_ACCOUNT_TEMPLATES,
  validateSystemChartTemplates,
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

describe('system chart of accounts', () => {
  it('defines a valid deterministic versioned hierarchy covering every account type', () => {
    // v2 added the courier cash receivable when the platform began taking
    // money at doors.
    expect(SYSTEM_CHART_VERSION).toBe(2)
    expect(() => validateSystemChartTemplates()).not.toThrow()
    expect(new Set(SYSTEM_LEDGER_ACCOUNT_TEMPLATES.map(({ code }) => code)).size).toBe(
      SYSTEM_LEDGER_ACCOUNT_TEMPLATES.length,
    )
    expect(
      SYSTEM_LEDGER_ACCOUNT_TEMPLATES.filter(({ parentKey }) => parentKey === null).map(
        ({ type }) => type,
      ),
    ).toEqual(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])
  })

  it('rejects duplicate and structurally invalid templates', () => {
    const assetRoot = SYSTEM_LEDGER_ACCOUNT_TEMPLATES[0]!
    expect(() =>
      validateSystemChartTemplates([...SYSTEM_LEDGER_ACCOUNT_TEMPLATES, assetRoot]),
    ).toThrow('unique')
    expect(() =>
      validateSystemChartTemplates([
        ...SYSTEM_LEDGER_ACCOUNT_TEMPLATES.filter(({ key }) => key !== 'ASSETS'),
        { ...assetRoot, isPostable: true },
      ]),
    ).toThrow('header')
  })
})

describe('ledger account governance', () => {
  const command = {
    accountId: 'account-1',
    currentActive: true,
    targetActive: false,
    parentActive: true,
    hasActiveChildren: false,
    actor: 'STAFF' as const,
    actorId: 'staff-1',
    idempotencyKey: 'ledger-governance-0001',
    reason: 'Temporarily unavailable for new postings',
    correlationId: 'correlation-1',
    occurredAt: new Date('2026-08-03T12:00:00.000Z'),
  }

  it('derives activation actions without changing financial identity', () => {
    expect(governLedgerAccount(command).action).toBe('DEACTIVATED')
    expect(
      governLedgerAccount({
        ...command,
        currentActive: false,
        targetActive: true,
      }).action,
    ).toBe('ACTIVATED')
  })

  it('rejects no-op, orphan activation, unsafe header deactivation and invalid authority', () => {
    expect(() => governLedgerAccount({ ...command, targetActive: true })).toThrow('already')
    expect(() =>
      governLedgerAccount({
        ...command,
        currentActive: false,
        targetActive: true,
        parentActive: false,
      }),
    ).toThrow('inactive parent')
    expect(() => governLedgerAccount({ ...command, hasActiveChildren: true })).toThrow(
      'active children',
    )
    expect(() => governLedgerAccount({ ...command, actor: 'SYSTEM' })).toThrow('invalid')
  })
})
