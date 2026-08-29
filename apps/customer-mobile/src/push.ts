/**
 * Asking the operating system for permission to interrupt somebody, and telling
 * the server where to reach them.
 *
 * Every step of this can legitimately fail, and none of the failures is worth
 * showing a customer. They did not ask for notifications; they asked for bread.
 * If registration does not work the order messages arrive by SMS exactly as
 * before, which is a complete service — so the whole path is best-effort and
 * silent, and the caller is told only whether it worked.
 *
 * The permission prompt is deliberately not fired at first launch. A stranger's
 * app asking to send notifications before it has done anything is the prompt
 * most people refuse, and iOS only ever asks once. Registration happens after
 * the customer has an order worth being told about, which is the moment the
 * request explains itself.
 */
export type PushRegistrationOutcome =
  /** Registered, and the server has the token. */
  | 'REGISTERED'
  /** The platform cannot receive remote notifications at all — the web build. */
  | 'UNSUPPORTED'
  /** The customer said no, or had said no before. */
  | 'DENIED'
  /** The build has no EAS project, so Expo will not issue a token. */
  | 'NOT_CONFIGURED'
  /** Something went wrong that is nobody's business but the log's. */
  | 'FAILED'

/**
 * The pieces of `expo-notifications` this needs, named so a test can supply
 * them.
 *
 * Injected rather than imported directly because the real module reaches the
 * operating system on import, and because these five outcomes are the whole
 * behaviour worth testing — none of which is reachable from a test runner
 * holding a real notifications module.
 */
export interface PushRuntime {
  getPermissionsAsync(): Promise<{ status: string; canAskAgain: boolean }>
  requestPermissionsAsync(): Promise<{ status: string }>
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>
  setNotificationChannelAsync?(name: string, options: Record<string, unknown>): Promise<unknown>
}

export interface PushRegistrar {
  register(input: { expoPushToken: string; platform: 'IOS' | 'ANDROID' }): Promise<unknown>
}

export async function registerForPushNotifications(input: {
  runtime: PushRuntime
  api: PushRegistrar
  /** From `extra.eas.projectId`. Absent in a build that was never made by EAS. */
  projectId: string | undefined
  /**
   * `Platform.OS`, passed in rather than read here.
   *
   * Importing `react-native` would make this module unloadable in the test
   * runner, which cannot parse the library's Flow source — and these five
   * outcomes are the only thing about push worth testing. The app's other
   * testable modules keep the same boundary for the same reason.
   */
  platform: string
  /**
   * Whether the permission prompt may be shown.
   *
   * False on every cold start: a token rotates, so a customer who already
   * agreed has to be re-registered each launch, and that must happen without
   * putting a dialog in front of somebody who is opening the app to buy bread.
   * True only after they place an order, which is the moment the request
   * explains itself.
   */
  askIfUndetermined: boolean
}): Promise<PushRegistrationOutcome> {
  const { platform } = input

  // The web build has no remote push, and asking would throw rather than
  // return. The site tells customers about orders in the page they are already
  // looking at.
  if (platform !== 'ios' && platform !== 'android') return 'UNSUPPORTED'

  // Expo issues a token against a project. Without one there is nothing to ask
  // for, and prompting the customer for permission we cannot then use would
  // spend the single prompt iOS allows on nothing.
  if (!input.projectId) return 'NOT_CONFIGURED'

  try {
    const existing = await input.runtime.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      // Only ask if asking can still succeed. On iOS a refusal is permanent
      // until the customer changes it in Settings, and re-requesting returns
      // the refusal without showing anything.
      if (!existing.canAskAgain || !input.askIfUndetermined) return 'DENIED'
      status = (await input.runtime.requestPermissionsAsync()).status
    }
    if (status !== 'granted') return 'DENIED'

    // Android delivers nothing without a channel, and one made after the first
    // notification arrives is one that missed it.
    if (platform === 'android' && input.runtime.setNotificationChannelAsync) {
      await input.runtime.setNotificationChannelAsync('orders', {
        name: 'سفارش‌ها',
        importance: 4,
        sound: 'default',
      })
    }

    const token = await input.runtime.getExpoPushTokenAsync({ projectId: input.projectId })
    if (!token.data) return 'FAILED'

    await input.api.register({
      expoPushToken: token.data,
      platform: platform === 'ios' ? 'IOS' : 'ANDROID',
    })
    return 'REGISTERED'
  } catch {
    // A push service that will not issue a token, a network that is down, an
    // API that refused the registration: all of them mean order messages keep
    // arriving by SMS, which is what happened before this existed.
    return 'FAILED'
  }
}
