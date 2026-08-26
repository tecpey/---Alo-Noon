import { z } from 'zod'

import { isoDateTimeSchema, responseMetaSchema, uuidSchema } from './common'

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

export const courierStatusSchema = z.enum(['AVAILABLE', 'UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED'])

export const createCourierCommandSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    /** Also how a courier signs in: the number is the link to their account. */
    mobileE164: z.string().regex(/^\+989\d{9}$/),
  })
  .strict()

export const setCourierStatusCommandSchema = z
  .object({
    status: courierStatusSchema,
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
  recipientPhone: z.string(),
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

export type CreateCourierCommand = z.infer<typeof createCourierCommandSchema>
export type SetCourierStatusCommand = z.infer<typeof setCourierStatusCommandSchema>
export const deliveryTaskEnvelopeSchema = z.object({
  success: z.literal(true),
  data: deliveryTaskSchema,
  meta: responseMetaSchema,
})

export const deliveryTaskListEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(deliveryTaskSchema),
  meta: responseMetaSchema,
})

export type DeliveryOfferCommand = z.infer<typeof deliveryOfferCommandSchema>
export type DeliveryReleaseCommand = z.infer<typeof deliveryReleaseCommandSchema>
export type CourierResponseCommand = z.infer<typeof courierResponseCommandSchema>
export type CourierReportCommand = z.infer<typeof courierReportCommandSchema>
export type DeliveryTaskView = z.infer<typeof deliveryTaskSchema>
export type CourierSummary = z.infer<typeof courierSummarySchema>

/**
 * Batching several orders into one courier run.
 *
 * Three commands rather than one, because batching decides that a customer will
 * wait longer than they otherwise would. That decision belongs to a person who
 * can see what it costs and what it saves — propose, then commit, then offer.
 */
export const tripProposeCommandSchema = z
  .object({
    /**
     * The delivery the run is built around. It is always the run's first
     * commitment: batching helps an order that already needs delivering, and
     * never holds one back while a companion is looked for.
     */
    anchorTaskId: uuidSchema,
  })
  .strict()

export const tripCreateCommandSchema = z
  .object({
    /**
     * An array rather than a set: the order given is the order that will be
     * ridden, and a dispatcher who sequenced it gets the sequence they chose.
     */
    taskIds: z.array(uuidSchema).min(1).max(10),
  })
  .strict()

export const tripDispatchCommandSchema = z
  .object({
    courierId: uuidSchema,
  })
  .strict()

export const tripStopSchema = z.object({
  taskId: uuidSchema,
  orderId: uuidSchema,
  orderCode: z.string().min(1).max(32),
  sequence: z.number().int().min(1),
  /** Riding distance from the previous stop, or from the branch for the first. */
  legMetres: z.number().int().min(0),
  plannedArrivalAt: isoDateTimeSchema,
  recipientName: z.string(),
  address: z.string(),
})

export const tripSchema = z.object({
  /** Empty on a proposal, which has not been written down. */
  tripId: z.string(),
  branchId: uuidSchema,
  state: z.enum(['PLANNED', 'DISPATCHED', 'COMPLETED', 'CANCELLED']),
  plannedDepartureAt: isoDateTimeSchema,
  plannedMetres: z.number().int().min(0),
  /**
   * What this run saves against delivering each drop on its own, in metres.
   * Zero for a single-drop run, which is the honest answer rather than a
   * flattering one.
   */
  savedMetres: z.number().int().min(0),
  stops: z.array(tripStopSchema),
})

export const tripEnvelopeSchema = z.object({
  success: z.literal(true),
  data: tripSchema,
  meta: responseMetaSchema,
})

export const tripListEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(tripSchema),
  meta: responseMetaSchema,
})

export type TripProposeCommand = z.infer<typeof tripProposeCommandSchema>
export type TripCreateCommand = z.infer<typeof tripCreateCommandSchema>
export type TripDispatchCommand = z.infer<typeof tripDispatchCommandSchema>
export type TripContract = z.infer<typeof tripSchema>
