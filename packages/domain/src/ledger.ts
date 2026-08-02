import { DomainError } from './errors'

export const LedgerAccountType = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
} as const
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType]

export const LedgerEntrySide = { DEBIT: 'DEBIT', CREDIT: 'CREDIT' } as const
export type LedgerEntrySide = (typeof LedgerEntrySide)[keyof typeof LedgerEntrySide]

export const FinancialTransactionType = { PAYMENT_CAPTURE: 'PAYMENT_CAPTURE' } as const
export type FinancialTransactionType =
  (typeof FinancialTransactionType)[keyof typeof FinancialTransactionType]

export interface JournalLine {
  accountId: string
  side: LedgerEntrySide
  amount: bigint
  currency: 'IRR'
}

export interface FinancialPosting {
  paymentId: string
  orderId: string
  type: FinancialTransactionType
  amount: bigint
  currency: 'IRR'
  idempotencyKey: string
  correlationId: string
  occurredAt: Date
  lines: readonly JournalLine[]
}

export function postDoubleEntry(
  posting: FinancialPosting,
): Readonly<FinancialPosting & { debitTotal: bigint; creditTotal: bigint }> {
  if (
    !posting.paymentId.trim() ||
    !posting.orderId.trim() ||
    posting.idempotencyKey.trim().length < 16 ||
    posting.idempotencyKey.length > 128 ||
    !posting.correlationId.trim() ||
    Number.isNaN(posting.occurredAt.getTime()) ||
    posting.currency !== 'IRR' ||
    posting.amount <= 0n
  ) {
    throw new DomainError('INVALID_FINANCIAL_TRANSACTION', 'Financial posting is invalid')
  }
  if (posting.lines.length < 2) {
    throw new DomainError(
      'UNBALANCED_FINANCIAL_TRANSACTION',
      'Double-entry posting requires at least two lines',
    )
  }

  let debitTotal = 0n
  let creditTotal = 0n
  const accounts = new Set<string>()
  const lines = posting.lines.map((line) => {
    if (!line.accountId.trim() || line.amount <= 0n || line.currency !== posting.currency) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger entries require a positive IRR amount')
    }
    accounts.add(line.accountId)
    if (line.side === LedgerEntrySide.DEBIT) debitTotal += line.amount
    else if (line.side === LedgerEntrySide.CREDIT) creditTotal += line.amount
    else throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger entry side is invalid')
    return Object.freeze({ ...line })
  })

  if (
    accounts.size < 2 ||
    debitTotal !== creditTotal ||
    debitTotal !== posting.amount ||
    creditTotal !== posting.amount
  ) {
    throw new DomainError(
      'UNBALANCED_FINANCIAL_TRANSACTION',
      'Debits and credits must balance to the transaction amount',
      { debitTotal: debitTotal.toString(), creditTotal: creditTotal.toString() },
    )
  }

  return Object.freeze({ ...posting, lines: Object.freeze(lines), debitTotal, creditTotal })
}
