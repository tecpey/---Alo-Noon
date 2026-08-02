import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, uuidSchema } from './common'

export const paymentAggregateStateSchema = z.enum([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
])
export type PaymentAggregateStateContract = z.infer<typeof paymentAggregateStateSchema>

export const ledgerAccountTypeSchema = z.enum([
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
])
export const ledgerEntrySideSchema = z.enum(['DEBIT', 'CREDIT'])
export const financialTransactionTypeSchema = z.enum(['PAYMENT_CAPTURE'])

export const ledgerAccountGovernanceActionSchema = z.enum([
  'PROVISIONED',
  'ACTIVATED',
  'DEACTIVATED',
])

export const ledgerAccountSummarySchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  name: z.string().min(1),
  type: ledgerAccountTypeSchema,
  currency: z.literal('IRR'),
  isSystem: z.boolean(),
  isPostable: z.boolean(),
  isActive: z.boolean(),
  systemKey: z.string().min(1).max(64).nullable(),
  templateVersion: z.number().int().positive().nullable(),
  governanceVersion: z.number().int().nonnegative(),
})
export type LedgerAccountSummary = z.infer<typeof ledgerAccountSummarySchema>

export const tenantFinancialBootstrapSummarySchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  templateVersion: z.number().int().positive(),
  accountCount: z.number().int().positive(),
  correlationId: uuidSchema,
  completedAt: isoDateTimeSchema,
  accounts: z.array(ledgerAccountSummarySchema).min(1),
})
export type TenantFinancialBootstrapSummary = z.infer<typeof tenantFinancialBootstrapSummarySchema>

export const paymentSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(8).max(32),
  orderId: uuidSchema,
  customerId: uuidSchema,
  state: paymentAggregateStateSchema,
  amount: moneySchema,
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})
export type PaymentSummary = z.infer<typeof paymentSummarySchema>

export const ledgerEntrySummarySchema = z.object({
  id: uuidSchema,
  accountId: uuidSchema,
  accountCode: z.string().min(1).max(64),
  sequence: z.number().int().min(1),
  side: ledgerEntrySideSchema,
  amount: moneySchema,
})
export type LedgerEntrySummary = z.infer<typeof ledgerEntrySummarySchema>

export const financialTransactionSummarySchema = z.object({
  id: uuidSchema,
  paymentId: uuidSchema,
  orderId: uuidSchema,
  type: financialTransactionTypeSchema,
  amount: moneySchema,
  correlationId: uuidSchema,
  occurredAt: isoDateTimeSchema,
  postedAt: isoDateTimeSchema,
  entries: z.array(ledgerEntrySummarySchema).min(2),
})
export type FinancialTransactionSummary = z.infer<typeof financialTransactionSummarySchema>
