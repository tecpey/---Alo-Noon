import { describe, expect, it } from 'vitest'

import {
  PUSH_DEVICE_STALE_AFTER_MS,
  composePushMessage,
  pushFailureIsPermanent,
  pushTitleForPurpose,
  selectPushDevices,
  type PushDeviceRecord,
} from './push-delivery'

const now = new Date('2026-08-29T06:00:00.000Z')

function device(overrides: Partial<PushDeviceRecord> & { id: string }): PushDeviceRecord {
  return {
    expoPushToken: `ExponentPushToken[${overrides.id}]`,
    platform: 'ANDROID',
    enabled: true,
    lastSeenAt: now,
    ...overrides,
  }
}

describe('selectPushDevices', () => {
  it('puts the handset seen most recently first', () => {
    const selected = selectPushDevices(
      [
        device({ id: 'old', lastSeenAt: new Date('2026-08-01T06:00:00.000Z') }),
        device({ id: 'today', lastSeenAt: new Date('2026-08-29T05:00:00.000Z') }),
      ],
      now,
    )
    expect(selected.map((entry) => entry.id)).toEqual(['today', 'old'])
  })

  it('drops a device the push service already told us is dead', () => {
    const selected = selectPushDevices([device({ id: 'dead', enabled: false })], now)
    expect(selected).toEqual([])
  })

  /**
   * The app re-registers on every sign-in and cold start, so a token nobody has
   * confirmed in three months belongs to an app that was removed without the
   * uninstall reaching us. Dropping it is what sends the message by SMS instead
   * of into nothing.
   */
  it('drops a token nobody has confirmed in three months', () => {
    const stale = new Date(now.getTime() - PUSH_DEVICE_STALE_AFTER_MS - 1)
    const fresh = new Date(now.getTime() - PUSH_DEVICE_STALE_AFTER_MS + 1)

    expect(selectPushDevices([device({ id: 'stale', lastSeenAt: stale })], now)).toEqual([])
    expect(selectPushDevices([device({ id: 'fresh', lastSeenAt: fresh })], now)).toHaveLength(1)
  })

  it('does not reorder the caller’s array', () => {
    const devices = [
      device({ id: 'old', lastSeenAt: new Date('2026-08-01T06:00:00.000Z') }),
      device({ id: 'today' }),
    ]
    selectPushDevices(devices, now)
    expect(devices.map((entry) => entry.id)).toEqual(['old', 'today'])
  })
})

describe('pushFailureIsPermanent', () => {
  /**
   * The refusal that arrives constantly. Treating it as retryable would mean
   * every uninstalled app costs a request on every order, and the customer
   * behind it never falls back to SMS.
   */
  it('retires a token the service says is not registered', () => {
    expect(pushFailureIsPermanent('DeviceNotRegistered')).toBe(true)
  })

  it('keeps a token through a rate limit', () => {
    expect(pushFailureIsPermanent('MessageRateExceeded')).toBe(false)
  })

  it('keeps a token when nothing was said at all', () => {
    expect(pushFailureIsPermanent(undefined)).toBe(false)
  })
})

describe('composePushMessage', () => {
  it('carries the same sentence the SMS would have', () => {
    const message = composePushMessage({
      purpose: 'ORDER_OUT_FOR_DELIVERY',
      body: 'سفارش TJR29BT8 راه افتاد.',
      orderId: '00000000-0000-4000-8000-0000000000d9',
      orderCode: 'TJR29BT8',
    })
    expect(message?.title).toBe('پیک راه افتاد')
    expect(message?.body).toBe('سفارش TJR29BT8 راه افتاد.')
    expect(message?.data).toEqual({
      orderId: '00000000-0000-4000-8000-0000000000d9',
      orderCode: 'TJR29BT8',
      purpose: 'ORDER_OUT_FOR_DELIVERY',
    })
  })

  /**
   * A one-time code pushed to every handset a customer ever installed the app
   * on is a one-time code delivered to whoever kept the old phone. Refusing it
   * here rather than trusting callers is the point.
   */
  it('refuses to push a sign-in code', () => {
    expect(
      composePushMessage({
        purpose: 'AUTH_OTP',
        body: 'کد ورود شما: ۱۲۳۴۵۶',
        orderId: '00000000-0000-4000-8000-0000000000d9',
        orderCode: 'TJR29BT8',
      }),
    ).toBeUndefined()
  })

  it('titles every order message it agrees to send', () => {
    const orderPurposes = [
      'ORDER_ACCEPTED',
      'ORDER_REJECTED',
      'ORDER_READY',
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_COMPLETED',
      'ORDER_CANCELLED',
    ] as const
    for (const purpose of orderPurposes) {
      expect(pushTitleForPurpose(purpose)).toBeTruthy()
    }
  })

  it('gives each one its own title', () => {
    const titles = [
      'ORDER_ACCEPTED',
      'ORDER_REJECTED',
      'ORDER_READY',
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_COMPLETED',
      'ORDER_CANCELLED',
    ].map((purpose) => pushTitleForPurpose(purpose as 'ORDER_ACCEPTED'))
    expect(new Set(titles).size).toBe(titles.length)
  })
})
