import { z } from 'zod'

import { uuidSchema } from './common'

/**
 * Dispatch and courier transport.
 *
 * The commands are deliberately thin. Which delivery is being acted on travels
 * in the path, and the destination of a courier's report is one of four fixed
 * words rather than free text, so a mistyped body cannot invent a state the
 * domain would then have to reject after the fact.
 */
export const deliveryOfferCommandSchema = z
  .object({
    courierId: uuidSchema,
  })
  .strict()

export const deliveryReleaseCommandSchema = z
  .object({
    reason: z.string().min(1).max(240).optional(),
  })
  .strict()

export const courierResponseCommandSchema = z
  .object({
    accept: z.boolean(),
  })
  .strict()

export const courierReportSchema = z.enum(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED'])

export const courierReportCommandSchema = z
  .object({
    to: courierReportSchema,
    /**
     * Required by the service when the report is FAILED. A failed delivery with
     * no reason gives a dispatcher nothing to decide with — try again, call the
     * customer, or refund — so the emptiness is refused rather than stored.
     */
    reasonCode: z.string().min(1).max(64).optional(),
  })
  .strict()

export const deliveryTaskSchema = z.object({
  taskId: uuidSchema,
  orderId: uuidSchema,
  orderPublicId: z.string().min(1).max(32),
  state: z.enum([
    'UNASSIGNED',
    'ASSIGNMENT_PENDING',
    'ASSIGNED',
    'PICKED_UP',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'FAILED',
    'CANCELLED',
  ]),
  attemptCount: z.number().int().nonnegative(),
  recipientName: z.string(),
  address: z.string(),
  bakeryName: z.string(),
  totalAmount: z.string(),
  deliverBefore: z.string().nullable(),
  courier: z
    .object({
      courierId: uuidSchema,
      displayName: z.string(),
      assignmentId: uuidSchema,
      state: z.string(),
    })
    .nullable(),
  updatedAt: z.string(),
})

export const courierSummarySchema = z.object({
  courierId: uuidSchema,
  displayName: z.string(),
  mobileE164: z.string(),
  status: z.enum(['ONBOARDING', 'AVAILABLE', 'UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED']),
  activeTasks: z.number().int().nonnegative(),
})

export type DeliveryOfferCommand = z.infer<typeof deliveryOfferCommandSchema>
export type DeliveryReleaseCommand = z.infer<typeof deliveryReleaseCommandSchema>
export type CourierResponseCommand = z.infer<typeof courierResponseCommandSchema>
export type CourierReportCommand = z.infer<typeof courierReportCommandSchema>
export type DeliveryTaskView = z.infer<typeof deliveryTaskSchema>
export type CourierSummary = z.infer<typeof courierSummarySchema>
