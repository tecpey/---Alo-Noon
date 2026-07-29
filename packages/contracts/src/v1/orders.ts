import { z } from 'zod'

import { addressInputSchema } from './geography'
import { moneySchema, uuidSchema } from './common'
import { productFulfillmentClassSchema } from './catalog'

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

export const orderItemSummarySchema = z.object({
  id: uuidSchema,
  skuSnapshot: z.string(),
  nameFaSnapshot: z.string(),
  fulfillmentClassSnapshot: productFulfillmentClassSchema,
  quantity: z.number().int().positive(),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})

export const orderSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(8).max(32),
  state: orderStateSchema,
  paymentState: paymentStateSchema,
  productionState: productionStateSchema,
  deliveryState: deliveryStateSchema,
  total: moneySchema,
  items: z.array(orderItemSummarySchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
})
export type OrderSummary = z.infer<typeof orderSummarySchema>
