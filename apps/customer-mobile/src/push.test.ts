import { describe, expect, it, vi } from 'vitest'

import { registerForPushNotifications, type PushRuntime } from './push'

const PROJECT_ID = '00000000-0000-4000-8000-000000000abc'
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'

function runtime(overrides: Partial<PushRuntime> = {}): PushRuntime {
  return {
    getPermissionsAsync: async () => ({ status: 'granted', canAskAgain: true }),
    requestPermissionsAsync: async () => ({ status: 'granted' }),
    getExpoPushTokenAsync: async () => ({ data: TOKEN }),
    setNotificationChannelAsync: async () => undefined,
    ...overrides,
  }
}

describe('registerForPushNotifications', () => {
  it('hands the server the token it was issued', async () => {
    const register = vi.fn().mockResolvedValue(undefined)

    const outcome = await registerForPushNotifications({
      runtime: runtime(),
      api: { register },
      projectId: PROJECT_ID,
      platform: 'ios',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('REGISTERED')
    expect(register).toHaveBeenCalledWith({ expoPushToken: TOKEN, platform: 'IOS' })
  })

  it('creates the Android channel before a notification can miss it', async () => {
    const setNotificationChannelAsync = vi.fn().mockResolvedValue(undefined)

    await registerForPushNotifications({
      runtime: runtime({ setNotificationChannelAsync }),
      api: { register: vi.fn().mockResolvedValue(undefined) },
      projectId: PROJECT_ID,
      platform: 'android',
      askIfUndetermined: true,
    })

    expect(setNotificationChannelAsync).toHaveBeenCalledWith('orders', expect.anything())
  })

  it('does not ask the web for something it cannot give', async () => {
    const getPermissionsAsync = vi.fn()

    const outcome = await registerForPushNotifications({
      runtime: runtime({ getPermissionsAsync }),
      api: { register: vi.fn() },
      projectId: PROJECT_ID,
      platform: 'web',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('UNSUPPORTED')
    expect(getPermissionsAsync).not.toHaveBeenCalled()
  })

  /**
   * iOS shows the permission prompt once, ever. Spending it in a build that
   * cannot then obtain a token would leave the customer refused for good and
   * the feature still not working.
   */
  it('does not spend the permission prompt when no token can be issued', async () => {
    const requestPermissionsAsync = vi.fn()

    const outcome = await registerForPushNotifications({
      runtime: runtime({ requestPermissionsAsync }),
      api: { register: vi.fn() },
      projectId: undefined,
      platform: 'ios',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('NOT_CONFIGURED')
    expect(requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('asks when permission has not been decided yet', async () => {
    const requestPermissionsAsync = vi.fn().mockResolvedValue({ status: 'granted' })

    const outcome = await registerForPushNotifications({
      runtime: runtime({
        getPermissionsAsync: async () => ({ status: 'undetermined', canAskAgain: true }),
        requestPermissionsAsync,
      }),
      api: { register: vi.fn().mockResolvedValue(undefined) },
      projectId: PROJECT_ID,
      platform: 'ios',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('REGISTERED')
    expect(requestPermissionsAsync).toHaveBeenCalledOnce()
  })

  /** Re-asking after a permanent refusal shows nothing and returns the refusal. */
  it('does not re-ask somebody who already said no', async () => {
    const requestPermissionsAsync = vi.fn()

    const outcome = await registerForPushNotifications({
      runtime: runtime({
        getPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }),
        requestPermissionsAsync,
      }),
      api: { register: vi.fn() },
      projectId: PROJECT_ID,
      platform: 'ios',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('DENIED')
    expect(requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('registers nothing when the customer refuses the prompt', async () => {
    const register = vi.fn()

    const outcome = await registerForPushNotifications({
      runtime: runtime({
        getPermissionsAsync: async () => ({ status: 'undetermined', canAskAgain: true }),
        requestPermissionsAsync: async () => ({ status: 'denied' }),
      }),
      api: { register },
      projectId: PROJECT_ID,
      platform: 'ios',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('DENIED')
    expect(register).not.toHaveBeenCalled()
  })

  /**
   * The customer asked for bread, not for notifications. Every failure here
   * leaves them exactly where they were — hearing about their order by SMS — so
   * none of them is worth an error on screen.
   */
  it('swallows a push service that will not issue a token', async () => {
    const outcome = await registerForPushNotifications({
      runtime: runtime({
        getExpoPushTokenAsync: async () => {
          throw new Error('no credentials for this project')
        },
      }),
      api: { register: vi.fn() },
      projectId: PROJECT_ID,
      platform: 'android',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('FAILED')
  })

  it('swallows an API that refuses the registration', async () => {
    const outcome = await registerForPushNotifications({
      runtime: runtime(),
      api: { register: vi.fn().mockRejectedValue(new Error('503')) },
      projectId: PROJECT_ID,
      platform: 'android',
      askIfUndetermined: true,
    })

    expect(outcome).toBe('FAILED')
  })
})

describe('the permission prompt on a cold start', () => {
  /**
   * A token rotates, so a customer who already agreed has to be re-registered
   * on every launch. That must not put a dialog in front of somebody who opened
   * the app to buy bread — and on iOS a prompt shown at the wrong moment is a
   * refusal that can never be asked about again.
   */
  it('re-registers somebody who already agreed, without asking', async () => {
    const requestPermissionsAsync = vi.fn()
    const register = vi.fn().mockResolvedValue(undefined)

    const outcome = await registerForPushNotifications({
      runtime: runtime({ requestPermissionsAsync }),
      api: { register },
      projectId: PROJECT_ID,
      platform: 'android',
      askIfUndetermined: false,
    })

    expect(outcome).toBe('REGISTERED')
    expect(register).toHaveBeenCalledOnce()
    expect(requestPermissionsAsync).not.toHaveBeenCalled()
  })

  it('stays silent rather than prompting an undecided customer', async () => {
    const requestPermissionsAsync = vi.fn()

    const outcome = await registerForPushNotifications({
      runtime: runtime({
        getPermissionsAsync: async () => ({ status: 'undetermined', canAskAgain: true }),
        requestPermissionsAsync,
      }),
      api: { register: vi.fn() },
      projectId: PROJECT_ID,
      platform: 'android',
      askIfUndetermined: false,
    })

    expect(outcome).toBe('DENIED')
    expect(requestPermissionsAsync).not.toHaveBeenCalled()
  })
})
