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

export const pushDevicePlatformSchema = z.enum(['IOS', 'ANDROID', 'WEB'])
export type PushDevicePlatform = z.infer<typeof pushDevicePlatformSchema>

/**
 * base64url that is exactly this many octets.
 *
 * Checked by character count, which for a fixed number of octets is not an
 * approximation: unpadded base64url encodes n octets in exactly
 * `ceil(n × 4 / 3)` characters, so 65 octets is 87 characters and 16 is 22,
 * with nothing else possible. The alphabet is checked separately, so a string
 * of the right length made of the wrong characters is refused too.
 *
 * Done this way rather than by decoding because these schemas are imported by
 * the shop's own pages as well as by the API: `Buffer` does not exist in a
 * browser, and `atob` is not in the type environment this package compiles
 * against. Neither is worth an import for a rule this simple.
 *
 * It matters because a key accepted one octet short is stored, sent to, and
 * silently discarded by the browser — a customer who is never told their bread
 * arrived, and no error anywhere that says why.
 */
function base64urlOctets(octets: number) {
  const characters = Math.ceil((octets * 4) / 3)
  return (value: string): boolean => value.length === characters && /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * A browser's push subscription, as the Push API hands it to the page.
 *
 * `endpoint` is the address, held by whichever push service the browser uses —
 * Google's for Chrome, Mozilla's for Firefox, Apple's for Safari — and it is
 * required to be https because the VAPID token this platform signs is bound to
 * that URL's origin. `p256dh` and `auth` are what make the payload readable
 * only by the browser that subscribed: the push service forwards ciphertext it
 * cannot open.
 */
export const webPushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .min(20)
    .max(500)
    .url()
    .refine((value) => value.startsWith('https://'), 'A push endpoint must be https'),
  keys: z.object({
    p256dh: z.string().trim().refine(base64urlOctets(65), 'Not an uncompressed P-256 point'),
    auth: z.string().trim().refine(base64urlOctets(16), 'Not a 16-octet authentication secret'),
  }),
})
export type WebPushSubscriptionInput = z.infer<typeof webPushSubscriptionSchema>

export const expoPushDeviceRegisterSchema = z.object({
  expoPushToken: expoPushTokenSchema,
  platform: z.enum(['IOS', 'ANDROID']),
})

export const webPushDeviceRegisterSchema = z.object({
  platform: z.literal('WEB'),
  subscription: webPushSubscriptionSchema,
})

/**
 * One endpoint, two kinds of device.
 *
 * Discriminated on `platform` rather than on the presence of a field, so a body
 * that is neither is refused as neither instead of being read as the branch
 * whose fields it happens to be missing. The Expo branch is unchanged, which
 * matters: the shipped mobile apps call this and are not going to be updated in
 * step with the server.
 */
export const pushDeviceRegisterSchema = z.discriminatedUnion('platform', [
  expoPushDeviceRegisterSchema,
  webPushDeviceRegisterSchema,
])
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

/**
 * The key a browser needs before it can subscribe at all.
 *
 * Public by definition — it is the application server's identity, and the whole
 * point of it is that a push service and a browser can both see it. It is
 * served rather than built into the page because the page is cached and the key
 * is deployment configuration: a shop that rotates its VAPID pair must not have
 * to wait for every installed copy of the site to be re-downloaded before
 * anybody can subscribe again.
 *
 * `null` is a real answer and means this deployment has no VAPID keys. A client
 * that gets it does not prompt for permission, which is better than prompting
 * and then failing: a notification permission, once refused, is refused for
 * good on most browsers.
 */
export const vapidPublicKeySchema = z
  .string()
  .trim()
  .refine(base64urlOctets(65), 'Not an uncompressed P-256 point')

export const webPushKeyEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ publicKey: vapidPublicKeySchema.nullable() }),
  meta: responseMetaSchema,
})
export type WebPushKeyEnvelope = z.infer<typeof webPushKeyEnvelopeSchema>
