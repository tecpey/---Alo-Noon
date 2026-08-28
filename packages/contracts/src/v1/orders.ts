import { z } from 'zod'

import { addressInputSchema } from './geography'
import { moneySchema, responseMetaSchema, uuidSchema } from './common'
import { productFulfillmentClassSchema } from './catalog'
import { paymentMethodSchema } from './payments'

export const orderStateSchema = z.enum([
  'DRAFT',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'IN_FULFILLMENT',
  'CANCEL_REQUESTED',
  'DELIVERY_FAILED',
  'COMPLETED',
  'CANCELLED',
])
export const paymentStateSchema = z.enum([
  'NOT_STARTED',
  'PENDING',
  'PAID',
  'REFUND_PENDING',
  'REFUNDED',
])
export const productionStateSchema = z.enum([
  'NOT_REQUIRED',
  'UNSCHEDULED',
  'SCHEDULED',
  'IN_PRODUCTION',
  'READY',
  'HANDED_OFF',
])
export const deliveryStateSchema = z.enum([
  'NOT_REQUIRED',
  'UNASSIGNED',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
])

export const orderDraftItemInputSchema = z.object({
  productVariantId: uuidSchema,
  bakeryProductOfferingId: uuidSchema,
  quantity: z.number().int().min(1).max(100),
  expectedUnitPrice: moneySchema,
})

export const orderDraftInputSchema = z.object({
  idempotencyKey: z.string().min(16).max(128),
  customerId: uuidSchema,
  bakeryBranchId: uuidSchema,
  deliveryAddress: addressInputSchema,
  requestedDeliveryAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(500).optional(),
  items: z.array(orderDraftItemInputSchema).min(1).max(50),
})
export type OrderDraftInput = z.infer<typeof orderDraftInputSchema>

export const orderCreateSchema = z.object({
  quoteId: uuidSchema,
  idempotencyKey: z.string().trim().min(16).max(128),
})
export type OrderCreate = z.infer<typeof orderCreateSchema>

export const orderItemSummarySchema = z.object({
  id: uuidSchema,
  skuSnapshot: z.string(),
  nameFaSnapshot: z.string(),
  fulfillmentClassSnapshot: productFulfillmentClassSchema,
  quantity: z.number().int().positive(),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})

/**
 * What a customer thought of an order.
 *
 * Two scores because two different things can go wrong and they belong to
 * different people: the bread is the bakery's and the delivery is the
 * courier's. A single star that blames both teaches nobody anything.
 */
export const orderRatingInputSchema = z.object({
  breadScore: z.number().int().min(1).max(5),
  deliveryScore: z.number().int().min(1).max(5).optional(),
  comment: z.string().trim().max(500).optional(),
})
export type OrderRatingInput = z.infer<typeof orderRatingInputSchema>

export const orderRatingSchema = z.object({
  orderId: uuidSchema,
  breadScore: z.number().int().min(1).max(5),
  deliveryScore: z.number().int().min(1).max(5).nullable(),
  comment: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
})
export type OrderRating = z.infer<typeof orderRatingSchema>

/**
 * The result of rebuilding a basket from a past order.
 *
 * `adjustments` is the important half. A customer who taps "order again" and
 * quietly receives two loaves instead of four has been let down twice: once by
 * the bakery and once by the interface that did not mention it.
 */
export const reorderResultSchema = z.object({
  cartId: uuidSchema,
  addedCount: z.number().int().min(0),
  adjustments: z.array(
    z.object({
      offeringId: uuidSchema,
      nameFa: z.string(),
      reason: z.enum(['REORDER_OFFERING_UNAVAILABLE', 'REORDER_QUANTITY_REDUCED']),
      quantity: z.number().int().min(0),
    }),
  ),
})
export type ReorderResult = z.infer<typeof reorderResultSchema>

export const favouriteSchema = z.object({
  offeringId: uuidSchema,
  productVariantId: uuidSchema,
  nameFa: z.string(),
  slug: z.string(),
  priceAmount: z.string(),
  /** False when it has sold out. Reported, not filtered — it is still their favourite. */
  available: z.boolean(),
})
export type Favourite = z.infer<typeof favouriteSchema>

export const orderSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(8).max(32),
  quoteId: uuidSchema,
  state: orderStateSchema,
  paymentState: paymentStateSchema,
  /** How this order is paid for. Cash orders are settled at the door. */
  paymentMethod: paymentMethodSchema,
  productionState: productionStateSchema,
  deliveryState: deliveryStateSchema,
  /**
   * What the customer said about it, if they said anything.
   *
   * Carried on the order rather than fetched separately so the interface can
   * tell, without another round trip, whether to offer the rating form at all.
   * Offering it for an order already rated invites somebody to fill in a form
   * that will be refused.
   */
  rating: orderRatingSchema.omit({ orderId: true }).nullable(),
  subtotal: moneySchema,
  deliveryFee: moneySchema,
  discount: moneySchema,
  total: moneySchema,
  items: z.array(orderItemSummarySchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
})
export type OrderSummary = z.infer<typeof orderSummarySchema>

export const orderEnvelopeSchema = z.object({
  success: z.literal(true),
  data: orderSummarySchema,
  meta: responseMetaSchema,
})

export const orderListEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(orderSummarySchema),
  meta: responseMetaSchema,
})
export type OrderListEnvelopeContract = z.infer<typeof orderListEnvelopeSchema>

/**
 * A staff command that moves an order.
 *
 * The destination is not in the body: each step has its own route, because
 * accepting an order and cancelling one are different acts with different
 * consequences and should not differ by one enum value in a payload.
 */
export const orderTransitionCommandSchema = z
  .object({
    reason: z.string().min(3).max(280),
  })
  .strict()
export type OrderTransitionCommand = z.infer<typeof orderTransitionCommandSchema>

export const productionTransitionCommandSchema = z
  .object({
    to: productionStateSchema,
    reason: z.string().min(3).max(280),
  })
  .strict()
export type ProductionTransitionCommand = z.infer<typeof productionTransitionCommandSchema>

export const orderOperationOutcomeSchema = z.object({
  orderId: uuidSchema,
  publicId: z.string().min(8).max(32),
  state: orderStateSchema,
  paymentState: paymentStateSchema,
  productionState: productionStateSchema,
  deliveryState: deliveryStateSchema,
  updatedAt: z.string().datetime({ offset: true }),
})
export type OrderOperationOutcomeContract = z.infer<typeof orderOperationOutcomeSchema>
