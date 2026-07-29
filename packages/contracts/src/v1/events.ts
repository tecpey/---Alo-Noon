import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

export const eventNameSchema = z.enum([
  'customer.created',
  'customer.address_added',
  'customer.preference_updated',
  'product.viewed',
  'product.added_to_cart',
  'order.created',
  'order.confirmed',
  'order.cancelled',
  'order.delivered',
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
