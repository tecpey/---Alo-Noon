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

export const FinancialTransactionType = {
  PAYMENT_CAPTURE: 'PAYMENT_CAPTURE',
  PAYMENT_REFUND: 'PAYMENT_REFUND',
} as const
export type FinancialTransactionType =
  (typeof FinancialTransactionType)[keyof typeof FinancialTransactionType]

/**
 * The newest system chart version.
 *
 * Two exist. v1 laid out the fourteen accounts every tenant starts with. v2
 * added a courier cash receivable when the platform took money at doors, and
 * provisions nothing now that it does not — the account it introduced is no
 * longer created, though the tenants that received it keep it.
 *
 * The number stays at 2 rather than reverting. A version is a migration of the
 * chart, and a chart that reached v2 reached it; renumbering would make an
 * existing tenant's history disagree with its own accounts.
 */
export const SYSTEM_CHART_VERSION = 2 as const

export interface SystemLedgerAccountTemplate {
  key: string
  code: string
  name: string
  type: LedgerAccountType
  parentKey: string | null
  isPostable: boolean
}

export const SYSTEM_LEDGER_ACCOUNT_TEMPLATES = Object.freeze([
  {
    key: 'ASSETS',
    code: 'A_1000',
    name: 'Assets',
    type: 'ASSET',
    parentKey: null,
    isPostable: false,
  },
  {
    key: 'CASH_CLEARING',
    code: 'A_1100_CASH_CLEARING',
    name: 'Cash clearing',
    type: 'ASSET',
    parentKey: 'ASSETS',
    isPostable: true,
  },
  {
    key: 'LIABILITIES',
    code: 'L_2000',
    name: 'Liabilities',
    type: 'LIABILITY',
    parentKey: null,
    isPostable: false,
  },
  {
    key: 'PAYMENT_CLEARING',
    code: 'L_2100_PAYMENT_CLEARING',
    name: 'Payment clearing',
    type: 'LIABILITY',
    parentKey: 'LIABILITIES',
    isPostable: true,
  },
  {
    key: 'BAKERY_PAYABLE',
    code: 'L_2200_BAKERY_PAYABLE',
    name: 'Bakery payable',
    type: 'LIABILITY',
    parentKey: 'LIABILITIES',
    isPostable: true,
  },
  {
    key: 'COURIER_PAYABLE',
    code: 'L_2300_COURIER_PAYABLE',
    name: 'Courier payable',
    type: 'LIABILITY',
    parentKey: 'LIABILITIES',
    isPostable: true,
  },
  {
    key: 'EQUITY',
    code: 'E_3000',
    name: 'Equity',
    type: 'EQUITY',
    parentKey: null,
    isPostable: false,
  },
  {
    key: 'RETAINED_EARNINGS',
    code: 'E_3100_RETAINED_EARNINGS',
    name: 'Retained earnings',
    type: 'EQUITY',
    parentKey: 'EQUITY',
    isPostable: true,
  },
  {
    key: 'REVENUE',
    code: 'R_4000',
    name: 'Revenue',
    type: 'REVENUE',
    parentKey: null,
    isPostable: false,
  },
  {
    key: 'PRODUCT_SALES_REVENUE',
    code: 'R_4100_PRODUCT_SALES',
    name: 'Product sales revenue',
    type: 'REVENUE',
    parentKey: 'REVENUE',
    isPostable: true,
  },
  {
    key: 'DELIVERY_REVENUE',
    code: 'R_4200_DELIVERY',
    name: 'Delivery revenue',
    type: 'REVENUE',
    parentKey: 'REVENUE',
    isPostable: true,
  },
  {
    key: 'EXPENSES',
    code: 'X_5000',
    name: 'Expenses',
    type: 'EXPENSE',
    parentKey: null,
    isPostable: false,
  },
  {
    key: 'DELIVERY_EXPENSE',
    code: 'X_5100_DELIVERY',
    name: 'Delivery expense',
    type: 'EXPENSE',
    parentKey: 'EXPENSES',
    isPostable: true,
  },
  {
    key: 'PAYMENT_PROCESSING_EXPENSE',
    code: 'X_5200_PAYMENT_PROCESSING',
    name: 'Payment processing expense',
    type: 'EXPENSE',
    parentKey: 'EXPENSES',
    isPostable: true,
  },
] satisfies readonly SystemLedgerAccountTemplate[])

export const LedgerAccountGovernanceAction = {
  PROVISIONED: 'PROVISIONED',
  ACTIVATED: 'ACTIVATED',
  DEACTIVATED: 'DEACTIVATED',
} as const
export type LedgerAccountGovernanceAction =
  (typeof LedgerAccountGovernanceAction)[keyof typeof LedgerAccountGovernanceAction]

export interface LedgerAccountGovernanceCommand {
  accountId: string
  currentActive: boolean
  targetActive: boolean
  parentActive: boolean | null
  hasActiveChildren: boolean
  actor: 'SYSTEM' | 'STAFF'
  actorId?: string
  idempotencyKey: string
  reason: string
  correlationId: string
  occurredAt: Date
}

export function validateSystemChartTemplates(
  templates: readonly SystemLedgerAccountTemplate[] = SYSTEM_LEDGER_ACCOUNT_TEMPLATES,
): void {
  const keys = new Set<string>()
  const codes = new Set<string>()
  const roots = new Set<LedgerAccountType>()
  for (const template of templates) {
    if (
      keys.has(template.key) ||
      codes.has(template.code) ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(template.code)
    ) {
      throw new DomainError(
        'INVALID_CHART_TEMPLATE',
        'System account keys and codes must be unique',
      )
    }
    if (template.parentKey === null) {
      if (template.isPostable || roots.has(template.type)) {
        throw new DomainError(
          'INVALID_CHART_TEMPLATE',
          'Each account type requires one header root',
        )
      }
      roots.add(template.type)
    } else {
      const parent = templates.find(({ key }) => key === template.parentKey)
      if (!parent || parent.type !== template.type || parent.isPostable) {
        throw new DomainError(
          'INVALID_CHART_TEMPLATE',
          'Account parents must be headers of the same type',
        )
      }
    }
    keys.add(template.key)
    codes.add(template.code)
  }
  if (roots.size !== Object.keys(LedgerAccountType).length) {
    throw new DomainError('INVALID_CHART_TEMPLATE', 'The chart must cover every account type')
  }
}

export function governLedgerAccount(
  command: LedgerAccountGovernanceCommand,
): Readonly<LedgerAccountGovernanceCommand & { action: LedgerAccountGovernanceAction }> {
  if (
    !command.accountId.trim() ||
    command.idempotencyKey.trim().length < 16 ||
    command.idempotencyKey.length > 128 ||
    !command.reason.trim() ||
    command.reason.length > 500 ||
    !command.correlationId.trim() ||
    Number.isNaN(command.occurredAt.getTime()) ||
    (command.actor === 'SYSTEM' ? command.actorId !== undefined : !command.actorId)
  ) {
    throw new DomainError('INVALID_LEDGER_GOVERNANCE', 'Ledger governance command is invalid')
  }
  if (command.currentActive === command.targetActive) {
    throw new DomainError('LEDGER_ACCOUNT_STATE_UNCHANGED', 'Ledger account already has that state')
  }
  if (command.targetActive && command.parentActive === false) {
    throw new DomainError(
      'LEDGER_PARENT_INACTIVE',
      'An account cannot activate below an inactive parent',
    )
  }
  if (!command.targetActive && command.hasActiveChildren) {
    throw new DomainError(
      'LEDGER_ACCOUNT_HAS_ACTIVE_CHILDREN',
      'A header with active children cannot deactivate',
    )
  }
  return Object.freeze({
    ...command,
    action: command.targetActive
      ? LedgerAccountGovernanceAction.ACTIVATED
      : LedgerAccountGovernanceAction.DEACTIVATED,
  })
}

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
