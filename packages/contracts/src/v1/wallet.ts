import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, responseMetaSchema, uuidSchema } from './common'

export const walletEntryKindSchema = z.enum([
  'TOP_UP',
  'ORDER_PAYMENT',
  'REFUND',
  'TRANSFER_IN',
  'TRANSFER_OUT',
])
export type WalletEntryKind = z.infer<typeof walletEntryKindSchema>

export const walletSummarySchema = z.object({
  id: uuidSchema,
  balance: moneySchema,
  updatedAt: isoDateTimeSchema,
})
export type WalletSummary = z.infer<typeof walletSummarySchema>

export const walletEnvelopeSchema = z.object({
  success: z.literal(true),
  data: walletSummarySchema,
  meta: responseMetaSchema,
})

/**
 * One line of a customer's statement.
 *
 * `balanceAfter` travels with each entry rather than being recomputed by the
 * client. A statement whose running total is derived on the reader's side is
 * one that disagrees with the server the moment a page boundary falls in the
 * wrong place.
 */
export const walletEntrySummarySchema = z.object({
  id: uuidSchema,
  kind: walletEntryKindSchema,
  amount: moneySchema,
  balanceAfter: moneySchema,
  orderId: uuidSchema.optional(),
  createdAt: isoDateTimeSchema,
})
export type WalletEntrySummary = z.infer<typeof walletEntrySummarySchema>

export const walletEntryListEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(walletEntrySummarySchema),
  meta: responseMetaSchema,
})

/**
 * Asking to charge a balance.
 *
 * The amount is a decimal string of Rial, like every other amount this API
 * accepts — a number would be a float somewhere in a client, and a float is not
 * a way to talk about money.
 */
export const walletTopUpCreateSchema = z.object({
  amount: z.string().regex(/^[1-9][0-9]{0,18}$/),
  idempotencyKey: z.string().trim().min(16).max(128),
})
export type WalletTopUpCreate = z.infer<typeof walletTopUpCreateSchema>
