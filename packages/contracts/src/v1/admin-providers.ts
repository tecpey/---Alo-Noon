import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'
import {
  paymentProviderAdapterVersionSchema,
  paymentProviderConfigurationCreateSchema,
  paymentProviderEnvironmentSchema,
  providerCredentialReferenceCreateSchema,
  providerHealthStatusSchema,
} from './payment-providers'

/**
 * Staff-facing provider governance transport.
 *
 * These commands carry references, never secret material: a credential is named
 * by an opaque `vault://`, `aws-sm://`, `gcp-sm://`, `local-encrypted://` or
 * `env://` reference whose value lives in the deployment's secret store. An
 * operator can therefore configure a gateway or SMS provider from the admin
 * panel without the API ever receiving, storing, or being able to echo back the
 * key itself.
 *
 * Every mutation requires a human-readable `reason`, which is what lands in the
 * audit trail alongside the acting account.
 */
const providerCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/)
const idempotencyKeySchema = z.string().min(16).max(128)
const governanceReasonSchema = z.string().min(4).max(500)

export const adminProviderCredentialCreateSchema = providerCredentialReferenceCreateSchema
  .extend({ idempotencyKey: idempotencyKeySchema })
  .strict()

export const adminProviderCredentialSummarySchema = z.object({
  id: uuidSchema,
  providerCode: providerCodeSchema,
  keyVersion: z.string().min(1).max(64),
  createdAt: isoDateTimeSchema,
})

export const adminPaymentProviderConfigurationCreateSchema =
  paymentProviderConfigurationCreateSchema.extend({ reason: governanceReasonSchema }).strict()

export const adminPaymentProviderGovernanceSchema = z
  .object({
    targetActive: z.boolean(),
    makeDefault: z.boolean(),
    idempotencyKey: idempotencyKeySchema,
    reason: governanceReasonSchema,
  })
  .strict()

/**
 * Selection only ever picks a HEALTHY configuration. A newly created gateway
 * starts UNKNOWN, so this is the governed attestation that it is live — and the
 * way to pull it out of rotation during an incident without deleting it.
 */
export const adminPaymentProviderHealthSchema = z
  .object({
    healthStatus: providerHealthStatusSchema,
    reason: governanceReasonSchema,
  })
  .strict()

/**
 * Mirrors the database CHECK constraint on AuthDeliveryProviderConfiguration.
 * A stricter `env://AUTH_SMS_*` shape is additionally enforced server-side,
 * because the environment-backed resolver only answers to that prefix.
 */
const authDeliveryCredentialReferenceSchema = z
  .string()
  .min(8)
  .max(250)
  .regex(/^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/)

export const adminAuthDeliveryConfigurationCreateSchema = z
  .object({
    providerCode: providerCodeSchema,
    adapterVersion: paymentProviderAdapterVersionSchema,
    environment: paymentProviderEnvironmentSchema,
    credentialReference: authDeliveryCredentialReferenceSchema,
    senderReference: z.string().min(1).max(128),
    templateReference: z.string().min(1).max(128),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    priority: z.number().int().min(1).max(1000).optional(),
    reason: governanceReasonSchema,
  })
  .strict()

/**
 * The configuration row is frozen by a database trigger after insert, so health
 * is the only field an operator can change. UNKNOWN is absent deliberately:
 * nothing may reset a provider to "never observed".
 */
export const adminAuthDeliveryHealthSchema = z
  .object({
    healthStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
    reason: governanceReasonSchema,
  })
  .strict()

export const adminAuthDeliveryConfigurationSummarySchema = z.object({
  id: uuidSchema,
  providerCode: providerCodeSchema,
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: z.literal(1),
  environment: paymentProviderEnvironmentSchema,
  senderReference: z.string().min(1).max(128),
  templateReference: z.string().min(1).max(128),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  priority: z.number().int().min(1).max(1000),
  healthStatus: providerHealthStatusSchema,
  createdAt: isoDateTimeSchema,
})

/**
 * Mirrors the CHECK constraint on RoutingProviderConfiguration. A stricter
 * `env://ROUTING_*` shape is additionally enforced server-side, because the
 * environment-backed resolver only answers to that prefix — and because the
 * prefix is what stops a configuration from naming an unrelated environment
 * variable and handing its value to a routing adapter.
 */
const routingCredentialReferenceSchema = z
  .string()
  .min(8)
  .max(250)
  .regex(/^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/)

export const adminRoutingConfigurationCreateSchema = z
  .object({
    providerCode: providerCodeSchema,
    adapterVersion: paymentProviderAdapterVersionSchema,
    environment: paymentProviderEnvironmentSchema,
    credentialReference: routingCredentialReferenceSchema,
    enabled: z.boolean(),
    isDefault: z.boolean(),
    priority: z.number().int().min(1).max(1000).optional(),
    reason: governanceReasonSchema,
  })
  .strict()

/**
 * Health is the only control after creation, as with SMS. UNKNOWN is absent
 * deliberately: nothing may reset an engine to "never observed" once it has
 * been.
 */
export const adminRoutingHealthSchema = z
  .object({
    healthStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
    reason: governanceReasonSchema,
  })
  .strict()

export const adminRoutingConfigurationSummarySchema = z.object({
  id: uuidSchema,
  providerCode: providerCodeSchema,
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: z.literal(1),
  environment: paymentProviderEnvironmentSchema,
  // The reference is safe to return and useful to see: an operator debugging
  // dead routing needs to know which variable the configuration points at. The
  // value behind it never leaves the deployment's secret store.
  credentialReference: routingCredentialReferenceSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  priority: z.number().int().min(1).max(1000),
  healthStatus: providerHealthStatusSchema,
  createdAt: isoDateTimeSchema,
})

/**
 * Deliberately loose, matching the database CHECK: one @, something either
 * side, no spaces. The authority on whether an address works is the receiving
 * mail server, and a stricter pattern here would refuse addresses that deliver
 * perfectly well.
 */
const emailAddressSchema = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)

export const adminEmailConfigurationCreateSchema = z
  .object({
    providerCode: providerCodeSchema,
    adapterVersion: paymentProviderAdapterVersionSchema,
    environment: paymentProviderEnvironmentSchema,
    // A stricter `env://EMAIL_*` shape is additionally enforced server-side,
    // because the environment-backed resolver only answers to that prefix.
    credentialReference: z
      .string()
      .min(8)
      .max(250)
      .regex(/^(?:env|vault|aws-sm|gcp-sm|azure-kv):\/\/[A-Za-z0-9_./:-]{1,240}$/),
    senderAddress: emailAddressSchema,
    senderName: z.string().min(1).max(128),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    priority: z.number().int().min(1).max(1000).optional(),
    reason: governanceReasonSchema,
  })
  .strict()

/**
 * Health is the only control after creation. UNKNOWN is absent deliberately:
 * nothing may reset a service to "never observed" once it has been.
 */
export const adminEmailHealthSchema = z
  .object({
    healthStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
    reason: governanceReasonSchema,
  })
  .strict()

export const adminEmailConfigurationSummarySchema = z.object({
  id: uuidSchema,
  providerCode: providerCodeSchema,
  adapterVersion: paymentProviderAdapterVersionSchema,
  adapterSpiVersion: z.literal(1),
  environment: paymentProviderEnvironmentSchema,
  credentialReference: z.string().min(8).max(250),
  // Printed on every message the tenant sends, so neither is a secret, and
  // both are what an operator needs when mail goes to spam.
  senderAddress: emailAddressSchema,
  senderName: z.string().min(1).max(128),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  priority: z.number().int().min(1).max(1000),
  healthStatus: providerHealthStatusSchema,
  createdAt: isoDateTimeSchema,
})

export type AdminProviderCredentialCreate = z.infer<typeof adminProviderCredentialCreateSchema>
export type AdminProviderCredentialSummary = z.infer<typeof adminProviderCredentialSummarySchema>
export type AdminPaymentProviderConfigurationCreate = z.infer<
  typeof adminPaymentProviderConfigurationCreateSchema
>
export type AdminPaymentProviderGovernance = z.infer<typeof adminPaymentProviderGovernanceSchema>
export type AdminPaymentProviderHealth = z.infer<typeof adminPaymentProviderHealthSchema>
export type AdminAuthDeliveryConfigurationCreate = z.infer<
  typeof adminAuthDeliveryConfigurationCreateSchema
>
export type AdminAuthDeliveryConfigurationSummary = z.infer<
  typeof adminAuthDeliveryConfigurationSummarySchema
>
export type AdminAuthDeliveryHealth = z.infer<typeof adminAuthDeliveryHealthSchema>
export type AdminRoutingConfigurationCreate = z.infer<typeof adminRoutingConfigurationCreateSchema>
export type AdminRoutingConfigurationSummary = z.infer<
  typeof adminRoutingConfigurationSummarySchema
>
export type AdminRoutingHealth = z.infer<typeof adminRoutingHealthSchema>
export type AdminEmailConfigurationCreate = z.infer<typeof adminEmailConfigurationCreateSchema>
export type AdminEmailConfigurationSummary = z.infer<typeof adminEmailConfigurationSummarySchema>
export type AdminEmailHealth = z.infer<typeof adminEmailHealthSchema>
