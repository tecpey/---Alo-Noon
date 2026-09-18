import type { MessageTemplatePurpose } from './message-template'

/**
 * Reaching a customer on their own handset, and deciding when to bother.
 *
 * Every order notification this platform sends costs money, because every one
 * of them is a text message. For a shop selling one basket a morning to the
 * same people, that is the largest recurring cost attached to an order after
 * the flour, and it grows in exact step with the thing the business is trying
 * to grow. A push to an installed app costs nothing.
 *
 * What push is not is reliable. A token expires, an app is deleted, a customer
 * switches notifications off, and none of that is visible here until a message
 * has already been thrown away. So push is preferred, never trusted: a refusal
 * falls back to SMS inside the same attempt, and the customer gets exactly one
 * message about each step of their order either way.
 *
 * Shaped like the SMS and email SPIs beside it for the same reason those share
 * a shape: an adapter is a pure translator between our vocabulary and a
 * vendor's. Which service is used and whether a device is worth trying are
 * decided outside it.
 */
export const PUSH_ADAPTER_SPI_VERSION = 2 as const

/**
 * Where a handset lives, and how it is addressed.
 *
 * Two transports rather than one, because there are two apps: the React Native
 * build, which Expo reaches by an opaque token, and the shop's own site added
 * to a home screen, which is reached by the browser's push service under RFC
 * 8030 with a subscription this platform encrypts to under RFC 8291.
 *
 * On iOS the second one is not a consolation. Apple does not accept Iranian
 * developer enrolments — `docs/product/IOS_DISTRIBUTION.md` quotes the refusal
 * — so an installed web app is the only iPhone this platform will ever reach,
 * and web push is the only way it can say "your bread is at the door".
 *
 * The two are kept in one list rather than two, so a customer who uses both is
 * reached on whichever they last opened. Two lists would need a priority
 * between them, and any priority is wrong for somebody.
 */
export type PushTransport = 'EXPO' | 'WEB_PUSH'

export type PushDevicePlatform = 'IOS' | 'ANDROID' | 'WEB'

/**
 * A browser's push subscription, exactly as the Push API hands it over.
 *
 * `endpoint` is a URL held by the browser vendor's push service and is the
 * address; `p256dh` is that installation's public key and `auth` a shared
 * secret, and both exist so the message is encrypted end to end — the push
 * service forwards a payload it cannot read. Losing either means the
 * subscription can still be posted to and the browser will discard what
 * arrives, which is the quiet failure this type exists to make impossible.
 */
export interface WebPushSubscription {
  /** The push service's URL for this installation. */
  readonly endpoint: string
  /** base64url of the uncompressed P-256 point, 65 octets. */
  readonly p256dh: string
  /** base64url of the 16-octet authentication secret. */
  readonly auth: string
}

interface PushDeviceCommon {
  readonly id: string
  readonly platform: PushDevicePlatform
  readonly enabled: boolean
  readonly lastSeenAt: Date
}

export interface ExpoPushDevice extends PushDeviceCommon {
  readonly transport: 'EXPO'
  readonly expoPushToken: string
}

export interface WebPushDevice extends PushDeviceCommon {
  readonly transport: 'WEB_PUSH'
  readonly subscription: WebPushSubscription
}

/**
 * A device as this layer needs to see it.
 *
 * A union rather than one shape with optional fields, so that no code can pass
 * an Expo token where a subscription belongs. The compiler does the check that
 * would otherwise be a runtime surprise on somebody's order.
 */
export type PushDeviceRecord = ExpoPushDevice | WebPushDevice

export interface PushMessage {
  /**
   * The line shown in bold on a lock screen.
   *
   * Separate from the body because a push has two halves and a customer reads
   * the first one from across the room. The body is the same sentence the SMS
   * would have carried, so the two channels say the same thing.
   */
  readonly title: string
  readonly body: string
  /**
   * What the app should open. Small on purpose — a payload is not a place to
   * put anything the app could not fetch for itself, and anything in here is
   * readable on a device we do not control.
   */
  readonly data: Readonly<Record<string, string>>
}

/**
 * The address to send to, without the rest of the device row.
 *
 * An adapter is given this rather than the `PushDeviceRecord` on purpose: it
 * has no business knowing when the device was last seen or whether it is
 * enabled, because those are the caller's decisions and an adapter that reads
 * them is an adapter that will one day act on them.
 */
export type PushTarget =
  | { readonly transport: 'EXPO'; readonly expoPushToken: string }
  | { readonly transport: 'WEB_PUSH'; readonly subscription: WebPushSubscription }

export function pushTargetFor(device: PushDeviceRecord): PushTarget {
  return device.transport === 'EXPO'
    ? { transport: 'EXPO', expoPushToken: device.expoPushToken }
    : { transport: 'WEB_PUSH', subscription: device.subscription }
}

export interface PushSendRequest {
  readonly target: PushTarget
  readonly message: PushMessage
  readonly timeoutMs: number
  readonly signal: { readonly aborted: boolean }
}

export type PushOutcome = 'DELIVERED' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE' | 'UNKNOWN'

export interface PushSendResult {
  readonly outcome: PushOutcome
  /** The ticket the service issued, when it issued one. */
  readonly providerReference?: string
  readonly normalizedCode?: string
}

export interface PushMessageProvider {
  readonly code: string
  /** Which kind of address this adapter can send to. */
  readonly transport: PushTransport
  readonly adapterVersion: string
  readonly spiVersion: typeof PUSH_ADAPTER_SPI_VERSION
  sendPush(request: PushSendRequest): Promise<PushSendResult>
}

/**
 * The adapter that can reach a device, or nothing.
 *
 * Nothing is an ordinary answer: a deployment that configured Expo but no VAPID
 * keys has web subscriptions in its database and no way to use them, and the
 * right behaviour is the one that was already there — the SMS carries the
 * message. Throwing here would turn a missing key into a customer hearing
 * nothing at all.
 */
export function pushProviderFor(
  providers: readonly PushMessageProvider[],
  device: PushDeviceRecord,
): PushMessageProvider | undefined {
  return providers.find((provider) => provider.transport === device.transport)
}

/**
 * Refusals that mean this token will never work again.
 *
 * `DeviceNotRegistered` is the one that matters and the one that arrives
 * constantly: it is what the push service says about an app that was deleted or
 * a token that was reissued. Retrying it forever would mean every uninstalled
 * app costs a request on every order, and the customer behind it never falls
 * back to SMS because the send keeps looking retryable.
 *
 * Everything else — a rate limit, a service having a bad minute — is transient,
 * and transient here means "SMS carries this one".
 *
 * The web push adapter answers in this same vocabulary rather than in HTTP
 * status codes: a browser push service says 404 or 410 for a subscription that
 * has been revoked, which is the same fact about the same kind of thing as
 * Expo's `DeviceNotRegistered`. Translating at the edge keeps one rule here
 * instead of one per transport, and keeps that rule readable against Expo's own
 * documentation.
 */
const PERMANENT_PUSH_FAILURES: ReadonlySet<string> = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MessageTooBig',
  // A stored web subscription whose keys will not encrypt. Separate from
  // `DeviceNotRegistered` because it is a different fact about a different
  // thing — the subscription is malformed rather than revoked — and an operator
  // reading `disabledReason` on the row deserves to be told which. Both retire
  // the device: neither will ever work again.
  'PUSH_SUBSCRIPTION_KEY_INVALID',
  'PUSH_SUBSCRIPTION_AUTH_INVALID',
])

export function pushFailureIsPermanent(code: string | undefined): boolean {
  return code !== undefined && PERMANENT_PUSH_FAILURES.has(code)
}

/**
 * How long a token is believed without being re-registered.
 *
 * The app re-registers on every sign-in and every cold start, so a token nobody
 * has confirmed in three months belongs to an app that was removed without the
 * uninstall ever reaching us. Trying it is not harmful — it just delays the SMS
 * that was always going to carry the message.
 */
export const PUSH_DEVICE_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000

/**
 * The devices worth trying, best first.
 *
 * Newest-seen first, because the handset someone opened this morning is the one
 * they are holding. Disabled and stale rows are dropped rather than sorted to
 * the back: a list that still contains them is a list somebody later iterates
 * over "just in case", which is how a dead token gets a retry loop.
 */
export function selectPushDevices(
  devices: readonly PushDeviceRecord[],
  now: Date,
): readonly PushDeviceRecord[] {
  return devices
    .filter(
      (device) =>
        device.enabled && now.getTime() - device.lastSeenAt.getTime() <= PUSH_DEVICE_STALE_AFTER_MS,
    )
    .slice()
    .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime())
}

/**
 * The bold line for each kind of message.
 *
 * Not taken from the message template, which is one field and is what the SMS
 * says in full. A title is a different piece of writing — it is read on a lock
 * screen, in a stack of other notifications, and it has to say which of these
 * five things happened before the customer decides whether to look.
 *
 * A purpose with no title here gets none rather than a generic one: a push that
 * says "الو نون" and nothing else is worse than one that opens straight into
 * its body.
 */
const PUSH_TITLES: Readonly<Partial<Record<MessageTemplatePurpose, string>>> = {
  ORDER_ACCEPTED: 'سفارشتان ثبت شد',
  ORDER_REJECTED: 'سفارشتان پذیرفته نشد',
  ORDER_READY: 'نان شما آماده است',
  ORDER_OUT_FOR_DELIVERY: 'پیک راه افتاد',
  ORDER_COMPLETED: 'سفارش تحویل شد',
  ORDER_CANCELLED: 'سفارش لغو شد',
}

export function pushTitleForPurpose(purpose: MessageTemplatePurpose): string | undefined {
  return PUSH_TITLES[purpose]
}

/**
 * The message a purpose becomes on a lock screen.
 *
 * Returns undefined when this purpose has no business being a push — sign-in
 * codes above all. A one-time code sent to every device a customer ever
 * installed the app on is a one-time code delivered to whoever kept the old
 * handset, and the OTP path deliberately has its own transport for reasons
 * this one does not carry.
 */
export function composePushMessage(input: {
  readonly purpose: MessageTemplatePurpose
  readonly body: string
  readonly orderId: string
  readonly orderCode: string
}): PushMessage | undefined {
  const title = pushTitleForPurpose(input.purpose)
  if (!title) return undefined
  return {
    title,
    body: input.body,
    data: { orderId: input.orderId, orderCode: input.orderCode, purpose: input.purpose },
  }
}
