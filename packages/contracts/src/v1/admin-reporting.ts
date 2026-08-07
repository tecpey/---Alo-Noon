import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, uuidSchema } from './common'
import {
  deliveryStateSchema,
  orderStateSchema,
  paymentStateSchema,
  productionStateSchema,
} from './orders'

/**
 * Staff-facing reporting and order inspection transport.
 *
 * Amounts are IRR minor units carried as decimal strings, matching every other
 * money field in the API: an order total in Rial routinely exceeds what a JSON
 * number can hold exactly, and a report that quietly rounds revenue is worse
 * than no report.
 *
 * The range is closed-open — `from` inclusive, `to` exclusive — so consecutive
 * periods tile without double-counting the boundary.
 */
export const reportRangeQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
  })
  .strict()
  .refine((range) => new Date(range.from) < new Date(range.to), {
    message: 'Report range must start before it ends',
  })

const countByStateSchema = z.record(z.number().int().min(0))

export const salesTotalsSchema = z.object({
  /** Orders that left DRAFT within the range. */
  placedOrders: z.number().int().min(0),
  placedValue: moneySchema,
  /**
   * Only orders the payment pipeline has actually marked PAID. Until capture is
   * implemented nothing reaches that state, so this reads zero by design rather
   * than by accident — `placedValue` is the figure with meaning today.
   */
  paidOrders: z.number().int().min(0),
  paidValue: moneySchema,
  cancelledOrders: z.number().int().min(0),
  cancelledValue: moneySchema,
  averageOrderValue: moneySchema,
  deliveryFees: moneySchema,
  discounts: moneySchema,
})

export const salesDailyPointSchema = z.object({
  /** Calendar date in the tenant's reporting timezone, as YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  placedOrders: z.number().int().min(0),
  placedValue: moneySchema,
})

export const topProductSchema = z.object({
  sku: z.string().min(1).max(64),
  productNameFa: z.string().min(1),
  variantNameFa: z.string().min(1),
  quantity: z.number().int().min(0),
  revenue: moneySchema,
})

export const conversionFunnelSchema = z.object({
  carts: z.number().int().min(0),
  quotes: z.number().int().min(0),
  orders: z.number().int().min(0),
  /** Orders per quote, 0–1, rounded to four places. Null when no quote exists. */
  quoteToOrderRate: z.number().min(0).max(1).nullable(),
})

export const salesReportSchema = z.object({
  range: z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
  totals: salesTotalsSchema,
  ordersByState: countByStateSchema,
  ordersByPaymentState: countByStateSchema,
  daily: z.array(salesDailyPointSchema),
  topProducts: z.array(topProductSchema),
  conversion: conversionFunnelSchema,
})

export const adminOrderListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    state: orderStateSchema.optional(),
    paymentState: paymentStateSchema.optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    /** Matches an order's public id or the recipient's mobile, exactly. */
    search: z.string().min(3).max(64).optional(),
  })
  .strict()

export const adminOrderSummarySchema = z.object({
  id: uuidSchema,
  publicId: z.string().min(1).max(32),
  state: orderStateSchema,
  paymentState: paymentStateSchema,
  productionState: productionStateSchema,
  deliveryState: deliveryStateSchema,
  customerId: uuidSchema,
  recipientNameSnapshot: z.string().min(1),
  bakeryNameSnapshot: z.string().min(1),
  totalAmount: moneySchema,
  itemCount: z.number().int().min(0),
  requestedDeliveryAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
})

export const adminOrderItemSchema = z.object({
  sku: z.string().min(1).max(64),
  productNameFa: z.string().min(1),
  variantNameFa: z.string().min(1),
  quantity: z.number().int().min(1),
  unitPrice: moneySchema,
  lineTotal: moneySchema,
})

export const adminOrderTransitionSchema = z.object({
  fromState: orderStateSchema.nullable(),
  toState: orderStateSchema,
  reasonCode: z.string().max(64).nullable(),
  occurredAt: isoDateTimeSchema,
})

export const adminOrderDetailSchema = adminOrderSummarySchema.extend({
  subtotalAmount: moneySchema,
  deliveryFeeAmount: moneySchema,
  discountAmount: moneySchema,
  /**
   * The recipient's phone is shown because an operator handling a failed
   * delivery has no other way to reach them. It is deliberately absent from the
   * list response, which is browsed far more often than it is acted on.
   */
  recipientPhoneSnapshot: z.string().min(1).max(16),
  deliveryAddressSnapshot: z.string().min(1),
  deliveryInstructionsSnapshot: z.string().nullable(),
  customerNotes: z.string().nullable(),
  cancellationReasonCode: z.string().max(64).nullable(),
  items: z.array(adminOrderItemSchema),
  transitions: z.array(adminOrderTransitionSchema),
  updatedAt: isoDateTimeSchema,
})

export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>
export type SalesReport = z.infer<typeof salesReportSchema>
export type SalesTotals = z.infer<typeof salesTotalsSchema>
export type TopProduct = z.infer<typeof topProductSchema>
export type ConversionFunnel = z.infer<typeof conversionFunnelSchema>
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>
export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>
export type AdminOrderDetail = z.infer<typeof adminOrderDetailSchema>
