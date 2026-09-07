import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, responseMetaSchema, uuidSchema } from './common'

export const walletEntryKindSchema = z.enum([
  'TOP_UP',
  'ORDER_PAYMENT',
  'REFUND',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'WITHDRAWAL',
  'WITHDRAWAL_REVERSAL',
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
  transferId: uuidSchema.optional(),
  /** The withdrawal this line belongs to: the debit, or the credit back. */
  withdrawalId: uuidSchema.optional(),
  createdAt: isoDateTimeSchema,
})
export type WalletEntrySummary = z.infer<typeof walletEntrySummarySchema>

export const walletWithdrawalStateSchema = z.enum(['REQUESTED', 'PAID', 'REJECTED'])

/**
 * A customer asking for their balance back, in money.
 *
 * The card is masked in both directions. The customer types a full number and
 * the API keeps four digits: the platform needs to know which card they meant
 * and has no business holding a complete one.
 */
export const walletWithdrawalSummarySchema = z.object({
  id: uuidSchema,
  amount: moneySchema,
  state: walletWithdrawalStateSchema,
  cardLastFour: z.string().regex(/^[0-9]{4}$/),
  cardHolderName: z.string().min(1).max(120),
  iban: z
    .string()
    .regex(/^IR[0-9]{24}$/)
    .optional(),
  bankReference: z.string().min(1).max(128).optional(),
  rejectionReason: z.string().min(1).max(500).optional(),
  requestedAt: isoDateTimeSchema,
  settledAt: isoDateTimeSchema.optional(),
})
export type WalletWithdrawalSummary = z.infer<typeof walletWithdrawalSummarySchema>

export const walletWithdrawalCreateSchema = z
  .object({
    amount: z.string().regex(/^[1-9][0-9]{0,18}$/),
    /**
     * The full card number, sent once and never stored. Sixteen digits is what
     * every Iranian debit card has; the API keeps the last four and forgets the
     * rest before the row is written.
     */
    cardNumber: z.string().regex(/^[0-9]{16}$/),
    cardHolderName: z.string().min(2).max(120),
    /** Optional, and what a real transfer is actually made against. */
    iban: z
      .string()
      .regex(/^IR[0-9]{24}$/)
      .optional(),
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict()
export type WalletWithdrawalCreate = z.infer<typeof walletWithdrawalCreateSchema>

/** Recording that somebody actually sent the money, and what the bank called it. */
export const walletWithdrawalPayCommandSchema = z
  .object({ bankReference: z.string().min(1).max(128) })
  .strict()

/**
 * Refusing one, with a reason the customer will read.
 *
 * Required, not optional: a rejection with no reason is a support call the
 * customer has to make to find out anything, and the money is already back on
 * their balance by the time they make it.
 */
export const walletWithdrawalRejectCommandSchema = z
  .object({ reason: z.string().min(3).max(500) })
  .strict()

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

/**
 * Asking to send part of a balance to somebody else.
 *
 * The recipient is named by phone number because that is the only handle a
 * customer has for another customer. Nothing is moved by this request — it
 * opens a transfer and sends the sender a code, and the money waits for that
 * code.
 */
export const walletTransferCreateSchema = z
  .object({
    recipientMobile: z.string().trim().min(10).max(20),
    amount: z.string().regex(/^[1-9][0-9]{0,18}$/),
    idempotencyKey: z.string().trim().min(16).max(128),
  })
  .strict()
export type WalletTransferCreate = z.infer<typeof walletTransferCreateSchema>

export const walletTransferConfirmSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[0-9]{4,8}$/),
  })
  .strict()
export type WalletTransferConfirm = z.infer<typeof walletTransferConfirmSchema>

export const walletTransferStateSchema = z.enum(['PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED'])

/**
 * A transfer as its sender sees it.
 *
 * The recipient is masked. Enough for the sender to recognise the person they
 * meant and catch the one they did not; not enough to turn a phone keypad into
 * a directory lookup on strangers.
 */
export const walletTransferSummarySchema = z.object({
  id: uuidSchema,
  state: walletTransferStateSchema,
  amount: moneySchema,
  recipientMobileMasked: z.string().min(4),
  recipientName: z.string().min(1).optional(),
  codeExpiresAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  settledAt: isoDateTimeSchema.optional(),
})
export type WalletTransferSummary = z.infer<typeof walletTransferSummarySchema>

export const walletTransferEnvelopeSchema = z.object({
  success: z.literal(true),
  data: walletTransferSummarySchema,
  meta: responseMetaSchema,
})

export const walletTransferListEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(walletTransferSummarySchema),
  meta: responseMetaSchema,
})

/**
 * What opening a top-up answers with.
 *
 * A payment id and nothing else. From there it is an ordinary gateway payment —
 * initialised, redirected to and settled by exactly the code an order's payment
 * uses, which is the whole reason a top-up reuses the payment aggregate.
 */
export const walletTopUpStartedEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ paymentId: uuidSchema }),
  meta: responseMetaSchema,
})
