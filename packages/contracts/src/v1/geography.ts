import { z } from 'zod'

import { responseMetaSchema, uuidSchema } from './common'

export const activeCitySummarySchema = z.object({
  id: uuidSchema,
  code: z.string().min(1).max(32),
  nameFa: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
})
export type ActiveCitySummary = z.infer<typeof activeCitySummarySchema>

export const activeCitiesEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(activeCitySummarySchema),
  meta: responseMetaSchema,
})
export type ActiveCitiesEnvelope = z.infer<typeof activeCitiesEnvelopeSchema>

export const addressInputSchema = z.object({
  cityId: uuidSchema,
  operationalZoneId: uuidSchema.optional(),
  label: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().regex(/^\+98\d{10}$/),
  addressLine: z.string().trim().min(10).max(500),
  postalCode: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  latitude: z.number().min(35).max(38.5),
  longitude: z.number().min(49).max(54.5),
  deliveryInstructions: z.string().trim().max(500).optional(),
})
export type AddressInput = z.infer<typeof addressInputSchema>

export const serviceabilityRequestSchema = z.object({
  cityId: uuidSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  requestedAt: z.string().datetime({ offset: true }).optional(),
})
export type ServiceabilityRequest = z.infer<typeof serviceabilityRequestSchema>

export const serviceabilityResponseSchema = z.object({
  serviceable: z.boolean(),
  operationalZoneId: uuidSchema.optional(),
  serviceAreaId: uuidSchema.optional(),
  reason: z.enum(['OUTSIDE_CITY', 'OUTSIDE_SERVICE_AREA', 'ZONE_SUSPENDED']).optional(),
  evaluatedAt: z.string().datetime({ offset: true }),
})
export type ServiceabilityResponse = z.infer<typeof serviceabilityResponseSchema>

export const serviceabilityEnvelopeSchema = z.object({
  success: z.literal(true),
  data: serviceabilityResponseSchema,
  meta: responseMetaSchema,
})
export type ServiceabilityEnvelope = z.infer<typeof serviceabilityEnvelopeSchema>
