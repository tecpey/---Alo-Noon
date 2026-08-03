import { z } from 'zod'

import { currencySchema, isoDateTimeSchema, uuidSchema } from './common'

export const paymentProviderCapabilitySchema = z.enum([
  'PAYMENT_INITIALIZATION',
  'CALLBACK_VERIFICATION',
  'PAYMENT_INQUIRY',
  'CANCELLATION',
  'REFUND',
])
export const paymentProviderEnvironmentSchema = z.enum(['TEST', 'PRODUCTION'])
export const paymentContextSchema = z.literal('CHECKOUT')
export const paymentProviderAdapterVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
export const paymentProviderAdapterSpiVersionSchema = z.literal(1)
export const providerHealthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY'])
export const paymentAttemptStateSchema = z.enum([
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
])

export const providerCredentialReferenceCreateSchema = z.object({
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  reference: z
    .string()
    .min(12)
    .max(500)
    .regex(/^(vault|aws-sm|gcp-sm|local-encrypted):\/\/[A-Za-z0-9/_:.-]+$/),
  keyVersion: z.string().min(1).max(64),
  metadata: z.record(z.string().max(200)).default({}),
})

export const paymentProviderConfigurationCreateSchema = z.object({
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: paymentProviderAdapterSpiVersionSchema,
  merchantReference: z.string().min(1).max(128),
  environment: paymentProviderEnvironmentSchema,
  paymentContext: paymentContextSchema,
  currency: currencySchema,
  callbackPolicy: z.literal('SIGNED_ONLY'),
  capabilities: z
    .array(paymentProviderCapabilitySchema)
    .min(1)
    .max(5)
    .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
      message: 'Provider capabilities must be unique',
    }),
  credentialReferenceId: uuidSchema,
  idempotencyKey: z.string().min(16).max(128),
})

export const paymentProviderConfigurationSummarySchema = z.object({
  id: uuidSchema,
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: paymentProviderAdapterSpiVersionSchema,
  merchantReference: z.string().min(1).max(128),
  environment: paymentProviderEnvironmentSchema,
  paymentContext: paymentContextSchema,
  currency: currencySchema,
  callbackPolicy: z.literal('SIGNED_ONLY'),
  capabilities: z.array(paymentProviderCapabilitySchema).min(1),
  credentialReferenceId: uuidSchema,
  isActive: z.boolean(),
  isDefault: z.boolean(),
  healthStatus: providerHealthStatusSchema,
  governanceVersion: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const paymentAttemptCreateSchema = z.object({
  paymentId: uuidSchema,
  environment: paymentProviderEnvironmentSchema,
  paymentContext: paymentContextSchema,
  idempotencyKey: z.string().min(16).max(128),
})

export const paymentAttemptSummarySchema = z.object({
  id: uuidSchema,
  paymentId: uuidSchema,
  providerConfigurationId: uuidSchema,
  state: paymentAttemptStateSchema,
  providerReference: z.string().min(1).max(200).nullable(),
  version: z.number().int().positive(),
  correlationId: uuidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const paymentInitializationOutcomeSchema = z.enum([
  'ACCEPTED',
  'CUSTOMER_ACTION_REQUIRED',
  'REJECTED',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'UNKNOWN',
])

export const paymentExecutionInitializeSchema = z
  .object({
    paymentId: uuidSchema,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict()

const customerActionSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .regex(
      /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^#\s]*)?$/,
      'Customer action URL must be an opaque HTTPS URL',
    ),
  expiresAt: isoDateTimeSchema.nullable(),
})

const paymentExecutionFailureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  retryable: z.boolean(),
  customerMessageKey: z
    .string()
    .regex(/^[a-z][a-z0-9_.-]{1,99}$/)
    .nullable(),
})

export const paymentExecutionSummarySchema = z.object({
  paymentAttemptId: uuidSchema,
  paymentId: uuidSchema,
  providerConfigurationId: uuidSchema,
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: paymentProviderAdapterSpiVersionSchema,
  state: z.enum(['INITIALIZATION_PENDING', 'INITIALIZED', 'CUSTOMER_ACTION_REQUIRED', 'FAILED']),
  outcome: paymentInitializationOutcomeSchema.nullable(),
  providerReference: z.string().min(1).max(200).nullable(),
  customerAction: customerActionSchema.nullable(),
  failure: paymentExecutionFailureSchema.nullable(),
  correlationId: uuidSchema,
  replayed: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
})

export const paymentCallbackIntakeSchema = z.object({
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  externalEventId: z.string().min(1).max(200),
  approvedHeaders: z
    .record(z.string().max(1000))
    .refine(
      (headers) =>
        Object.keys(headers).every((header) =>
          ['x-provider-event-id', 'x-provider-signature-version', 'x-provider-timestamp'].includes(
            header.toLowerCase(),
          ),
        ),
      'Callback header is not approved for persistence',
    )
    .default({}),
  canonicalPayload: z.record(z.unknown()),
  receivedAt: isoDateTimeSchema,
  idempotencyKey: z.string().min(16).max(128),
})

export const paymentCallbackReceiptSummarySchema = z.object({
  id: uuidSchema,
  providerConfigurationId: uuidSchema,
  paymentAttemptId: uuidSchema.nullable(),
  externalEventId: z.string().min(1).max(200),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  headersFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED', 'REJECTED']),
  processingStatus: z.enum(['RECEIVED', 'PROCESSED', 'REJECTED']),
  receivedAt: isoDateTimeSchema,
})

export type PaymentProviderCapabilityContract = z.infer<typeof paymentProviderCapabilitySchema>
export type PaymentProviderConfigurationCreate = z.infer<
  typeof paymentProviderConfigurationCreateSchema
>
export type PaymentProviderConfigurationSummary = z.infer<
  typeof paymentProviderConfigurationSummarySchema
>
export type PaymentAttemptCreate = z.infer<typeof paymentAttemptCreateSchema>
export type PaymentAttemptSummary = z.infer<typeof paymentAttemptSummarySchema>
export type PaymentExecutionInitialize = z.infer<typeof paymentExecutionInitializeSchema>
export type PaymentExecutionSummary = z.infer<typeof paymentExecutionSummarySchema>
export type PaymentCallbackIntake = z.infer<typeof paymentCallbackIntakeSchema>
export type PaymentCallbackReceiptSummary = z.infer<typeof paymentCallbackReceiptSummarySchema>
