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
  'financial.chart_provisioned',
  'financial.ledger_account_state_changed',
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

export const financialChartProvisionedEventPayloadSchema = z.object({
  tenantId: uuidSchema,
  templateVersion: z.number().int().positive(),
  accountCount: z.number().int().positive(),
})
export type FinancialChartProvisionedEventPayload = z.infer<
  typeof financialChartProvisionedEventPayloadSchema
>

export const ledgerAccountStateChangedEventPayloadSchema = z.object({
  ledgerAccountId: uuidSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  fromActive: z.boolean(),
  toActive: z.boolean(),
  version: z.number().int().positive(),
  reason: z.string().min(1).max(500),
})
export type LedgerAccountStateChangedEventPayload = z.infer<
  typeof ledgerAccountStateChangedEventPayloadSchema
>

export const paymentProviderConfigurationEventPayloadSchema = z.object({
  providerConfigurationId: uuidSchema,
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  adapterSpiVersion: z.literal(1),
  environment: z.enum(['TEST', 'PRODUCTION']),
  paymentContext: z.literal('CHECKOUT'),
  currency: z.literal('IRR'),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  version: z.number().int().positive(),
})

export const providerCredentialReferenceCreatedEventPayloadSchema = z.object({
  credentialReferenceId: uuidSchema,
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  keyVersion: z.string().min(1).max(64),
})

export const paymentAttemptEventPayloadSchema = z.object({
  paymentAttemptId: uuidSchema,
  paymentId: uuidSchema,
  providerConfigurationId: uuidSchema,
  state: z.enum([
    'CREATED',
    'INITIALIZATION_PENDING',
    'INITIALIZED',
    'CUSTOMER_ACTION_REQUIRED',
    'CALLBACK_RECEIVED',
    'VERIFICATION_PENDING',
    'VERIFIED',
    'REJECTED',
    'FAILED',
    'EXPIRED',
  ]),
  version: z.number().int().positive(),
})

export const paymentCallbackEventPayloadSchema = z.object({
  callbackReceiptId: uuidSchema,
  providerConfigurationId: uuidSchema,
  paymentAttemptId: uuidSchema.nullable(),
  externalEventId: z.string().min(1).max(200),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED', 'REJECTED']),
  processingStatus: z.enum(['RECEIVED', 'PROCESSED', 'REJECTED']),
})
