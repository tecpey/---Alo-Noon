import { z } from 'zod'

import { isoDateTimeSchema, moneySchema } from './common'

/**
 * Staff-facing financial reporting transport.
 *
 * Three questions, answered separately because they fail separately:
 *
 * - **Does the ledger balance?** Every posting is double-entry, so total debits
 *   must equal total credits. If they ever diverge, no other figure on this page
 *   means anything, which is why it is reported as its own flag rather than
 *   buried in a table an operator has to add up.
 * - **Did the money that customers paid actually arrive?** Captured value
 *   against orders marked paid, and the receipts still waiting or refused.
 * - **Which gateway is failing?** Attempts by state, per provider, so a broken
 *   gateway shows as its own column rather than as a dip in the total.
 *
 * Every amount is IRR minor units as a decimal string. A trial balance total
 * over a month of a working city exceeds what a JSON number holds exactly, and a
 * balance check that rounds is not a balance check.
 */
export const trialBalanceRowSchema = z.object({
  accountCode: z.string().min(1).max(64),
  accountName: z.string().min(1),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  debits: moneySchema,
  credits: moneySchema,
  /**
   * Signed by what the account type means: assets and expenses are positive
   * when debited, everything else when credited. Reporting a raw
   * debits-minus-credits would show every liability as negative, which is
   * correct bookkeeping and unreadable operations.
   */
  balance: z.object({ amount: z.string().regex(/^-?\d+$/), currency: z.literal('IRR') }),
  entryCount: z.number().int().min(0),
})

/**
 * The trial balance is cumulative *as of* the range's end, not confined to it.
 * A balance for one week in isolation is not a balance — it omits everything
 * carried in — so the range narrows the settlement figures below while this
 * reports the ledger's whole position up to that moment.
 */
export const trialBalanceSchema = z.object({
  asOf: isoDateTimeSchema,
  rows: z.array(trialBalanceRowSchema),
  totalDebits: moneySchema,
  totalCredits: moneySchema,
  /**
   * False means the ledger is internally inconsistent — a posting landed with
   * unequal sides, which the database constraints are supposed to make
   * impossible. It is surfaced rather than asserted because an operator finding
   * out is better than a report that refuses to render.
   */
  balanced: z.boolean(),
})

export const settlementReconciliationSchema = z.object({
  /** Sum of every PAYMENT_CAPTURE posted in the range. */
  capturedValue: moneySchema,
  capturedCount: z.number().int().min(0),
  /**
   * Of the captures above, how many belong to an order that actually reads
   * PAID. Dated by the capture rather than by the order's own `updatedAt`,
   * which is auto-managed and would move an order into whatever period it was
   * last edited in.
   */
  paidOrders: z.number().int().min(0),
  paidOrderValue: moneySchema,
  /**
   * Captured value minus the value of the orders those captures paid. Non-zero
   * means money moved that the order side does not acknowledge — a capture
   * whose order never reached PAID, which is the crash window settlement's
   * ordering is designed to leave recoverable rather than silent.
   */
  captureToOrderGap: z.object({ amount: z.string().regex(/^-?\d+$/), currency: z.literal('IRR') }),
  paymentsByState: z.record(z.number().int().min(0)),
  receipts: z.object({
    total: z.number().int().min(0),
    /** Received but not yet settled — the recovery sweep's backlog. */
    awaitingProcessing: z.number().int().min(0),
    processed: z.number().int().min(0),
    /**
     * Refused settlement. Each one is either an attack or a bug, and both need
     * a human; the reason is on the audit trail under
     * `payment.callback_settlement_decided`.
     */
    rejected: z.number().int().min(0),
    /** Oldest unprocessed receipt, or null when the backlog is empty. */
    oldestAwaitingAt: isoDateTimeSchema.nullable(),
  }),
})

export const providerFunnelRowSchema = z.object({
  providerCode: z.string().min(1).max(64),
  environment: z.enum(['TEST', 'PRODUCTION']),
  attempts: z.number().int().min(0),
  verified: z.number().int().min(0),
  rejected: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** Started but not concluded: still mid-flight, or abandoned by the customer. */
  inFlight: z.number().int().min(0),
  /** Verified over attempts, 0–1 to four places. Null when nothing was tried. */
  verificationRate: z.number().min(0).max(1).nullable(),
})

export const financialReportSchema = z.object({
  range: z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
  trialBalance: trialBalanceSchema,
  settlement: settlementReconciliationSchema,
  providers: z.array(providerFunnelRowSchema),
})

export type TrialBalanceRow = z.infer<typeof trialBalanceRowSchema>
export type TrialBalance = z.infer<typeof trialBalanceSchema>
export type SettlementReconciliation = z.infer<typeof settlementReconciliationSchema>
export type ProviderFunnelRow = z.infer<typeof providerFunnelRowSchema>
export type FinancialReport = z.infer<typeof financialReportSchema>
