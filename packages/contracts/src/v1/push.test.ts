import { describe, expect, it } from 'vitest'

import { pushDeviceRegisterSchema, vapidPublicKeySchema, webPushSubscriptionSchema } from './push'

/**
 * What a device may claim about itself.
 *
 * The failure these schemas guard against does not look like a failure. A
 * subscription accepted with a key that is one octet short is stored, sent to,
 * and silently discarded by the browser: the customer is never told their bread
 * arrived and nothing anywhere records why. So the shape is checked here, at
 * the edge, where a refusal is still a 400 somebody can read.
 */

// The example subscription from RFC 8291 §5, which is a real P-256 point and a
// real 16-octet secret rather than a string of the right length.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg'
const ENDPOINT = 'https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV'

describe('a browser push subscription', () => {
  it('accepts what the Push API actually hands the page', () => {
    const parsed = webPushSubscriptionSchema.safeParse({
      endpoint: ENDPOINT,
      keys: { p256dh: P256DH, auth: AUTH },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a key of the wrong size', () => {
    // 64 octets instead of 65: the uncompressed-point prefix dropped, which is
    // the mistake a hand-rolled client makes and which nothing downstream would
    // report.
    expect(
      webPushSubscriptionSchema.safeParse({
        endpoint: ENDPOINT,
        keys: { p256dh: P256DH.slice(2), auth: AUTH },
      }).success,
    ).toBe(false)
    expect(
      webPushSubscriptionSchema.safeParse({
        endpoint: ENDPOINT,
        keys: { p256dh: P256DH, auth: AUTH.slice(0, 20) },
      }).success,
    ).toBe(false)
  })

  it('refuses standard base64, which is not what the Push API emits', () => {
    const standard = P256DH.replaceAll('-', '+').replaceAll('_', '/')
    expect(
      webPushSubscriptionSchema.safeParse({
        endpoint: ENDPOINT,
        keys: { p256dh: standard, auth: AUTH },
      }).success,
    ).toBe(false)
  })

  it('refuses an endpoint that is not https', () => {
    // The VAPID token is signed for this URL's origin. A plaintext endpoint is
    // also a push service that could be anybody.
    expect(
      webPushSubscriptionSchema.safeParse({
        endpoint: 'http://push.example.net/p/abcdefghijklmnop',
        keys: { p256dh: P256DH, auth: AUTH },
      }).success,
    ).toBe(false)
  })
})

describe('registering a device', () => {
  /**
   * The shipped mobile apps call this endpoint and are not going to be updated
   * in step with the server. Their body must keep working exactly as it did.
   */
  it('still accepts the body the mobile apps already send', () => {
    const parsed = pushDeviceRegisterSchema.safeParse({
      expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      platform: 'ANDROID',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a browser', () => {
    const parsed = pushDeviceRegisterSchema.safeParse({
      platform: 'WEB',
      subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
    })
    expect(parsed.success).toBe(true)
  })

  /**
   * Discriminated on the platform, so a body that is neither is refused as
   * neither rather than read as whichever branch it is least short of.
   */
  it('refuses a browser that sends an Expo token', () => {
    expect(
      pushDeviceRegisterSchema.safeParse({
        platform: 'WEB',
        expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      }).success,
    ).toBe(false)
  })

  it('refuses a handset that sends a subscription', () => {
    expect(
      pushDeviceRegisterSchema.safeParse({
        platform: 'IOS',
        subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
      }).success,
    ).toBe(false)
  })
})

describe('the VAPID public key', () => {
  it('is an uncompressed P-256 point', () => {
    expect(
      vapidPublicKeySchema.safeParse(
        'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
      ).success,
    ).toBe(true)
    expect(vapidPublicKeySchema.safeParse('not-a-key').success).toBe(false)
  })
})
