import { z } from 'zod'

import { isoDateTimeSchema, responseMetaSchema, uuidSchema } from './common'

export const mobileE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Mobile number must use E.164 format')

export const otpRequestSchema = z.object({
  mobileE164: mobileE164Schema,
})
export type OtpRequest = z.infer<typeof otpRequestSchema>

export const otpRequestAcceptedSchema = z.object({
  challengeId: uuidSchema,
  expiresAt: isoDateTimeSchema,
  retryAfterSeconds: z.number().int().min(0),
})
export type OtpRequestAccepted = z.infer<typeof otpRequestAcceptedSchema>

export const otpRequestEnvelopeSchema = z.object({
  success: z.literal(true),
  data: otpRequestAcceptedSchema,
  meta: responseMetaSchema,
})
export type OtpRequestEnvelope = z.infer<typeof otpRequestEnvelopeSchema>

export const otpVerifySchema = z.object({
  challengeId: uuidSchema,
  code: z.string().regex(/^\d{6}$/, 'OTP code must contain exactly six digits'),
})
export type OtpVerifyRequest = z.infer<typeof otpVerifySchema>

export const authorizationScopeTypeSchema = z.enum([
  'GLOBAL',
  'CITY',
  'OPERATIONAL_ZONE',
  'BAKERY_BRANCH',
  'COURIER_PARTNER',
  'SELF',
])
export type AuthorizationScopeType = z.infer<typeof authorizationScopeTypeSchema>

export const accessGrantSchema = z.object({
  roleCode: z.string().min(1).max(64),
  permissions: z.array(z.string().min(1).max(100)),
  scopeType: authorizationScopeTypeSchema,
  scopeId: uuidSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
})
export type AccessGrantContract = z.infer<typeof accessGrantSchema>

export const sessionContextSchema = z.object({
  accountId: uuidSchema,
  customerId: uuidSchema.nullable(),
  expiresAt: isoDateTimeSchema,
  grants: z.array(accessGrantSchema),
})
export type SessionContext = z.infer<typeof sessionContextSchema>

export const sessionEnvelopeSchema = z.object({
  success: z.literal(true),
  data: sessionContextSchema,
  meta: responseMetaSchema,
})
export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>
