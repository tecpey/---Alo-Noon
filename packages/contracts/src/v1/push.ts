import { z } from 'zod'

import { isoDateTimeSchema, responseMetaSchema, uuidSchema } from './common'

/**
 * Registering the handset an order notification can reach.
 *
 * The token is checked against the shape Expo issues rather than accepted as
 * any string. Everything about a device row is addressed by this value, so a
 * client that sends something else would create a row that can never receive
 * anything and can never be cleaned up by the thing that owns it.
 */
export const expoPushTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9._-]+\]$/, 'Not an Expo push token')

export const pushDevicePlatformSchema = z.enum(['IOS', 'ANDROID'])
export type PushDevicePlatform = z.infer<typeof pushDevicePlatformSchema>

export const pushDeviceRegisterSchema = z.object({
  expoPushToken: expoPushTokenSchema,
  platform: pushDevicePlatformSchema,
})
export type PushDeviceRegister = z.infer<typeof pushDeviceRegisterSchema>

/**
 * What comes back is deliberately thin.
 *
 * The token is not echoed. The client sent it and already has it, and a
 * response that repeats it puts the address of somebody's handset into every
 * log and proxy between here and there for no purpose.
 */
export const pushDeviceSummarySchema = z.object({
  id: uuidSchema,
  platform: pushDevicePlatformSchema,
  enabled: z.boolean(),
  lastSeenAt: isoDateTimeSchema,
})
export type PushDeviceSummary = z.infer<typeof pushDeviceSummarySchema>

export const pushDeviceEnvelopeSchema = z.object({
  success: z.literal(true),
  data: pushDeviceSummarySchema,
  meta: responseMetaSchema,
})
export type PushDeviceEnvelope = z.infer<typeof pushDeviceEnvelopeSchema>
