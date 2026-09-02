import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, responseMetaSchema, uuidSchema } from './common'

export const paymentAggregateStateSchema = z.enum([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
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
/**
 * Where the money for an order comes from.
 *
 * Two routes, and money reaches the platform before an order is final on both.
 * A gateway takes it from a card now; a wallet took it from a card earlier and
 * has been holding it since. There is no third — nothing is settled at the
 * door.
 */
export const paymentMethodSchema = z.enum(['ONLINE_GATEWAY', 'WALLET'])
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

export const financialTransactionTypeSchema = z.enum([
  'PAYMENT_CAPTURE',
  'PAYMENT_REFUND',
  'WALLET_TOP_UP',
])

/** What a payment is for. A top-up has no order; an order payment must have one. */
export const paymentPurposeSchema = z.enum(['ORDER', 'WALLET_TOP_UP'])
export type PaymentPurpose = z.infer<typeof paymentPurposeSchema>

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
  /** Absent on a wallet top-up, which is a payment with nothing to deliver. */
  orderId: uuidSchema.optional(),
  purpose: paymentPurposeSchema.default('ORDER'),
  customerId: uuidSchema,
  state: paymentAggregateStateSchema,
  amount: moneySchema,
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})
export type PaymentSummary = z.infer<typeof paymentSummarySchema>

/**
 * Opening a payment for an order the caller owns.
 *
 * Carries only the order and an idempotency key: the amount comes from the
 * order's own total, never from the request, because a client-supplied amount
 * is a client-chosen price.
 */
export const paymentCheckoutStartSchema = z
  .object({
    orderId: uuidSchema,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict()
export type PaymentCheckoutStart = z.infer<typeof paymentCheckoutStartSchema>

export const paymentEnvelopeSchema = z.object({
  success: z.literal(true),
  data: paymentSummarySchema,
  meta: responseMetaSchema,
})
export type PaymentEnvelopeContract = z.infer<typeof paymentEnvelopeSchema>

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
  /** Absent on a wallet top-up, the one posting with nothing to deliver. */
  orderId: uuidSchema.optional(),
  type: financialTransactionTypeSchema,
  amount: moneySchema,
  correlationId: uuidSchema,
  occurredAt: isoDateTimeSchema,
  postedAt: isoDateTimeSchema,
  entries: z.array(ledgerEntrySummarySchema).min(2),
})
export type FinancialTransactionSummary = z.infer<typeof financialTransactionSummarySchema>
