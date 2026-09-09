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
export const PUSH_ADAPTER_SPI_VERSION = 1 as const

export type PushDevicePlatform = 'IOS' | 'ANDROID'

/** A device as this layer needs to see it. */
export interface PushDeviceRecord {
  readonly id: string
  readonly expoPushToken: string
  readonly platform: PushDevicePlatform
  readonly enabled: boolean
  readonly lastSeenAt: Date
}

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

export interface PushSendRequest {
  readonly token: string
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
  readonly adapterVersion: string
  readonly spiVersion: typeof PUSH_ADAPTER_SPI_VERSION
  sendPush(request: PushSendRequest): Promise<PushSendResult>
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
 */
const PERMANENT_PUSH_FAILURES: ReadonlySet<string> = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MessageTooBig',
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
