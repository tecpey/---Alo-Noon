import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

export const eventNameSchema = z.enum([
  'customer.created',
  'customer.address_added',
  'customer.preference_updated',
  'product.viewed',
  'product.added_to_cart',
  'cart.item_upserted',
  'cart.item_removed',
  'quote.created',
  'order.created',
  'order.confirmed',
  'order.cancelled',
  'order.delivered',
  'payment.created',
  'payment.state_changed',
  'financial.transaction_posted',
  'support.case_created',
])

export const eventEnvelopeSchema = z.object({
  eventId: uuidSchema,
  name: eventNameSchema,
  version: z.literal(1),
  purpose: z.enum(['DOMAIN', 'AUDIT', 'ENGAGEMENT']),
  occurredAt: isoDateTimeSchema,
  actor: z.object({
    type: z.enum(['CUSTOMER', 'STAFF', 'BAKERY', 'COURIER', 'SYSTEM']),
    id: uuidSchema.optional(),
  }),
  subject: z.object({ type: z.string().min(1).max(80), id: uuidSchema }),
  correlationId: uuidSchema,
  causationId: uuidSchema.optional(),
  consentBasis: z.enum(['NOT_REQUIRED', 'TRANSACTIONAL', 'EXPLICIT_CONSENT']),
  payload: z.record(z.unknown()),
})
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

export const orderCreatedEventPayloadSchema = z.object({
  orderId: uuidSchema,
  quoteId: uuidSchema,
  customerId: uuidSchema,
  bakeryBranchId: uuidSchema,
  bakeryCapacitySlotId: uuidSchema,
  state: z.literal('PENDING_CONFIRMATION'),
  totalAmount: z.string().regex(/^\d+$/),
  currency: z.literal('IRR'),
})
export type OrderCreatedEventPayload = z.infer<typeof orderCreatedEventPayloadSchema>

export const paymentCreatedEventPayloadSchema = z.object({
  paymentId: uuidSchema,
  orderId: uuidSchema,
  customerId: uuidSchema,
  state: z.literal('CREATED'),
  amount: z.string().regex(/^\d+$/),
  currency: z.literal('IRR'),
})
export type PaymentCreatedEventPayload = z.infer<typeof paymentCreatedEventPayloadSchema>

export const paymentStateChangedEventPayloadSchema = z.object({
  paymentId: uuidSchema,
  orderId: uuidSchema,
  fromState: z.enum(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED']),
  toState: z.enum(['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED']),
  version: z.number().int().min(2),
})
export type PaymentStateChangedEventPayload = z.infer<typeof paymentStateChangedEventPayloadSchema>

export const financialTransactionPostedEventPayloadSchema = z.object({
  financialTransactionId: uuidSchema,
  paymentId: uuidSchema,
  orderId: uuidSchema,
  type: z.literal('PAYMENT_CAPTURE'),
  amount: z.string().regex(/^\d+$/),
  currency: z.literal('IRR'),
  entryCount: z.number().int().min(2),
})
export type FinancialTransactionPostedEventPayload = z.infer<
  typeof financialTransactionPostedEventPayloadSchema
>
