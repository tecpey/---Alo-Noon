import type { Prisma, PrismaClient } from '@alo-noon/database'
import type {
  FinancialReport,
  ProviderFunnelRow,
  ReportRangeQuery,
  SettlementReconciliation,
  TrialBalance,
} from '@alo-noon/contracts'

/**
 * Read-only financial reporting over the tenant's own ledger and payments.
 *
 * Everything runs inside a tenant-scoped transaction, so row-level security
 * applies here exactly as it does on the customer-facing paths. A financial
 * report that bypassed RLS would be the one place one tenant could read
 * another's books.
 *
 * Aggregates are computed in SQL. A month of a working city is tens of
 * thousands of ledger entries, and every total is bigint Rial that must not pass
 * through a JavaScript number on the way out — `SUM` over bigint returns
 * `numeric` in Postgres, which Prisma hands back as a Decimal, so each one is
 * cast back to `bigint` explicitly rather than left to coerce.
 */
export interface AdminFinancialReportingService {
  financialReport(tenantId: string, range: ReportRangeQuery): Promise<FinancialReport>
}

export class AdminFinancialReportingError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AdminFinancialReportingError'
  }
}

// The same ceiling the sales report uses: wide enough to be a mistake, and wide
// enough to hurt.
const MAX_RANGE_DAYS = 400

/** Account types whose natural balance is a debit. */
const DEBIT_NATURAL: readonly string[] = ['ASSET', 'EXPENSE']

export function createPrismaAdminFinancialReportingService(
  prisma: PrismaClient,
): AdminFinancialReportingService {
  return {
    async financialReport(tenantId, range) {
      const from = new Date(range.from)
      const to = new Date(range.to)
      assertRange(from, to)

      return tenantTransaction(prisma, tenantId, async (transaction) => {
        const [trialBalance, settlement, providers] = await Promise.all([
          queryTrialBalance(transaction, tenantId, to),
          querySettlement(transaction, tenantId, from, to),
          queryProviderFunnel(transaction, tenantId, from, to),
        ])
        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          trialBalance,
          settlement,
          providers,
        }
      })
    },
  }
}

function assertRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AdminFinancialReportingError('REPORT_RANGE_INVALID')
  }
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new AdminFinancialReportingError('REPORT_RANGE_TOO_WIDE')
  }
}

interface TrialBalanceRowRaw {
  code: string
  name: string
  type: string
  debits: bigint | null
  credits: bigint | null
  entry_count: bigint
}

/**
 * Cumulative balances as of `asOf`, over accounts that have been posted to.
 *
 * Accounts with no entries are omitted deliberately: the chart provisions
 * dozens of accounts a pilot never touches, and a page of zeroes buries the
 * handful that carry money.
 */
async function queryTrialBalance(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  asOf: Date,
): Promise<TrialBalance> {
  const rows = await transaction.$queryRaw<TrialBalanceRowRaw[]>`
    SELECT
      a."code"                                                            AS code,
      a."name"                                                            AS name,
      a."type"::text                                                      AS type,
      COALESCE(SUM(e."amount") FILTER (WHERE e."side" = 'DEBIT'), 0)::bigint  AS debits,
      COALESCE(SUM(e."amount") FILTER (WHERE e."side" = 'CREDIT'), 0)::bigint AS credits,
      COUNT(e."id")                                                       AS entry_count
    FROM "LedgerAccount" a
    JOIN "LedgerEntry" e
      ON e."ledgerAccountId" = a."id" AND e."tenantId" = a."tenantId"
    JOIN "FinancialTransaction" t
      ON t."id" = e."financialTransactionId" AND t."tenantId" = e."tenantId"
    WHERE a."tenantId" = ${tenantId}::uuid AND t."postedAt" < ${asOf}
    GROUP BY a."code", a."name", a."type"
    ORDER BY a."code"`

  let totalDebits = 0n
  let totalCredits = 0n
  const mapped = rows.map((row) => {
    const debits = row.debits ?? 0n
    const credits = row.credits ?? 0n
    totalDebits += debits
    totalCredits += credits
    const natural = DEBIT_NATURAL.includes(row.type) ? debits - credits : credits - debits
    return {
      accountCode: row.code,
      accountName: row.name,
      accountType: row.type as TrialBalance['rows'][number]['accountType'],
      debits: money(debits),
      credits: money(credits),
      balance: { amount: natural.toString(), currency: 'IRR' as const },
      entryCount: Number(row.entry_count),
    }
  })

  return {
    asOf: asOf.toISOString(),
    rows: mapped,
    totalDebits: money(totalDebits),
    totalCredits: money(totalCredits),
    balanced: totalDebits === totalCredits,
  }
}

interface CaptureRow {
  captured_value: bigint | null
  captured_count: bigint
}

interface PaidOrderRow {
  paid_orders: bigint
  paid_value: bigint | null
}

interface ReceiptRow {
  total: bigint
  awaiting: bigint
  processed: bigint
  rejected: bigint
  oldest_awaiting: Date | null
}

async function querySettlement(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<SettlementReconciliation> {
  const [captureRows, paidRows, receiptRows, paymentStates] = await Promise.all([
    transaction.$queryRaw<CaptureRow[]>`
      SELECT
        COALESCE(SUM("amount"), 0)::bigint AS captured_value,
        COUNT(*)                          AS captured_count
      FROM "FinancialTransaction"
      WHERE "tenantId" = ${tenantId}::uuid AND "type" = 'PAYMENT_CAPTURE'
        AND "postedAt" >= ${from} AND "postedAt" < ${to}`,

    // Dated by the capture that paid the order, not by the order's own
    // `updatedAt`. That column is auto-managed: a delivery note added weeks
    // later would move the order into a period it was not paid in.
    transaction.$queryRaw<PaidOrderRow[]>`
      SELECT
        COUNT(*)                                  AS paid_orders,
        COALESCE(SUM(o."totalAmount"), 0)::bigint AS paid_value
      FROM "FinancialTransaction" t
      JOIN "Order" o ON o."id" = t."orderId" AND o."tenantId" = t."tenantId"
      WHERE t."tenantId" = ${tenantId}::uuid AND t."type" = 'PAYMENT_CAPTURE'
        AND o."paymentState" = 'PAID'
        AND t."postedAt" >= ${from} AND t."postedAt" < ${to}`,

    transaction.$queryRaw<ReceiptRow[]>`
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE "processingStatus" = 'RECEIVED')   AS awaiting,
        COUNT(*) FILTER (WHERE "processingStatus" = 'PROCESSED')  AS processed,
        COUNT(*) FILTER (WHERE "processingStatus" = 'REJECTED')   AS rejected,
        MIN("receivedAt") FILTER (WHERE "processingStatus" = 'RECEIVED') AS oldest_awaiting
      FROM "PaymentCallbackReceipt"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "receivedAt" >= ${from} AND "receivedAt" < ${to}`,

    transaction.$queryRaw<Array<{ bucket: string; total: bigint }>>`
      SELECT "state"::text AS bucket, COUNT(*) AS total
      FROM "Payment"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY "state"`,
  ])

  const capturedValue = captureRows[0]?.captured_value ?? 0n
  const paidOrderValue = paidRows[0]?.paid_value ?? 0n
  const receipts = receiptRows[0]

  const paymentsByState: Record<string, number> = {}
  for (const row of paymentStates) paymentsByState[row.bucket] = Number(row.total)

  return {
    capturedValue: money(capturedValue),
    capturedCount: Number(captureRows[0]?.captured_count ?? 0n),
    paidOrders: Number(paidRows[0]?.paid_orders ?? 0n),
    paidOrderValue: money(paidOrderValue),
    // Signed, and deliberately not clamped: a negative gap means orders were
    // marked paid that nothing captured, which is the more alarming direction.
    captureToOrderGap: { amount: (capturedValue - paidOrderValue).toString(), currency: 'IRR' },
    paymentsByState,
    receipts: {
      total: Number(receipts?.total ?? 0n),
      awaitingProcessing: Number(receipts?.awaiting ?? 0n),
      processed: Number(receipts?.processed ?? 0n),
      rejected: Number(receipts?.rejected ?? 0n),
      oldestAwaitingAt: receipts?.oldest_awaiting?.toISOString() ?? null,
    },
  }
}

interface ProviderFunnelRaw {
  provider_code: string
  environment: string
  attempts: bigint
  verified: bigint
  rejected: bigint
  failed: bigint
}

/**
 * Attempts grouped by the gateway that handled them.
 *
 * Grouped by provider and environment rather than by configuration id: a tenant
 * that rotates a gateway's credentials gets a second configuration for the same
 * gateway, and splitting the funnel across them would hide a failure in half.
 */
async function queryProviderFunnel(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<ProviderFunnelRow[]> {
  const rows = await transaction.$queryRaw<ProviderFunnelRaw[]>`
    SELECT
      c."providerCode"                                             AS provider_code,
      c."environment"::text                                        AS environment,
      COUNT(*)                                                     AS attempts,
      COUNT(*) FILTER (WHERE a."state" = 'VERIFIED')               AS verified,
      COUNT(*) FILTER (WHERE a."state" = 'REJECTED')               AS rejected,
      COUNT(*) FILTER (WHERE a."state" IN ('FAILED', 'EXPIRED'))   AS failed
    FROM "PaymentAttempt" a
    JOIN "PaymentProviderConfiguration" c
      ON c."id" = a."providerConfigurationId" AND c."tenantId" = a."tenantId"
    WHERE a."tenantId" = ${tenantId}::uuid
      AND a."createdAt" >= ${from} AND a."createdAt" < ${to}
    GROUP BY c."providerCode", c."environment"
    ORDER BY attempts DESC, provider_code ASC`

  return rows.map((row) => {
    const attempts = Number(row.attempts)
    const verified = Number(row.verified)
    const concluded = verified + Number(row.rejected) + Number(row.failed)
    return {
      providerCode: row.provider_code,
      environment: row.environment as ProviderFunnelRow['environment'],
      attempts,
      verified,
      rejected: Number(row.rejected),
      failed: Number(row.failed),
      // Everything that started and has not reached a terminal state: still
      // mid-flight, or a customer who closed the tab.
      inFlight: attempts - concluded,
      verificationRate: attempts > 0 ? Math.round((verified / attempts) * 10_000) / 10_000 : null,
    }
  })
}

function money(amount: bigint): { amount: string; currency: 'IRR' } {
  return { amount: (amount < 0n ? 0n : amount).toString(), currency: 'IRR' }
}

async function tenantTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    // Reporting reads a lot and must never block a customer paying.
    { isolationLevel: 'ReadCommitted' },
  )
}
