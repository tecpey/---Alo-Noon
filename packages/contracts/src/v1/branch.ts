import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, uuidSchema } from './common'

/**
 * The bakery partner's own surface.
 *
 * Everything here is scoped to the branches the caller's grants name, and the
 * branch is never in the request — a request that could name a branch would let
 * any partner name any branch. So these schemas carry no branch selector at all:
 * the session decides, and the reply says which branches it decided on.
 */
export const branchContextSchema = z.object({
  branchId: uuidSchema,
  branchNameFa: z.string().min(1),
  bakeryId: uuidSchema,
  bakeryNameFa: z.string().min(1),
  cityNameFa: z.string().min(1),
  operationalStatus: z.string().min(1).max(32),
  /** Shown so a partner can see the rate their share was computed from. */
  commissionBasisPoints: z.number().int().min(0).max(10_000),
})
export type BranchContext = z.infer<typeof branchContextSchema>

export const branchOrderItemSchema = z.object({
  productNameFa: z.string().min(1),
  variantNameFa: z.string().min(1),
  quantity: z.number().int().positive(),
})

export const branchOrderSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(4).max(32),
  branchId: uuidSchema,
  state: z.string().min(1).max(32),
  paymentState: z.string().min(1).max(32),
  productionState: z.string().min(1).max(32),
  deliveryState: z.string().min(1).max(32),
  recipientNameSnapshot: z.string().min(1),
  itemCount: z.number().int().min(0),
  /** The bread, before delivery and before commission — what the branch made. */
  subtotalAmount: moneySchema,
  totalAmount: moneySchema,
  requestedDeliveryAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  items: z.array(branchOrderItemSchema),
})
export type BranchOrderSummary = z.infer<typeof branchOrderSummarySchema>

export const branchQueueQuerySchema = z
  .object({
    /**
     * `LIVE` is the default because it is what a counter is for. A queue with
     * yesterday's delivered orders mixed into it is a queue nobody reads.
     */
    scope: z.enum(['LIVE', 'ALL']).default('LIVE'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
export type BranchQueueQuery = z.infer<typeof branchQueueQuerySchema>

export const branchEarningsSchema = z.object({
  unpaid: moneySchema,
  unpaidOrderCount: z.number().int().min(0),
  paid: moneySchema,
  paidOrderCount: z.number().int().min(0),
  commission: moneySchema,
  oldestUnpaidAt: isoDateTimeSchema.nullable(),
  recent: z.array(
    z.object({
      orderId: uuidSchema,
      publicId: z.string().min(4).max(32),
      occurredAt: isoDateTimeSchema,
      total: moneySchema,
      commission: moneySchema,
      share: moneySchema,
      paid: z.boolean(),
    }),
  ),
})
export type BranchEarnings = z.infer<typeof branchEarningsSchema>

/** A step a counter takes on its own order. The reason is what the audit reads. */
export const branchOrderStepCommandSchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict()
export type BranchOrderStepCommand = z.infer<typeof branchOrderStepCommandSchema>

export const branchProductionCommandSchema = z
  .object({
    to: z.enum(['SCHEDULED', 'IN_PRODUCTION', 'READY', 'HANDED_OFF']),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()
export type BranchProductionCommand = z.infer<typeof branchProductionCommandSchema>
