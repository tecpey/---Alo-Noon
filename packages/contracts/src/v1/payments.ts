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
