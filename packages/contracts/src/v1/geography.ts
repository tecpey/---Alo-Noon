import { z } from 'zod'

import { uuidSchema } from './common'

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
