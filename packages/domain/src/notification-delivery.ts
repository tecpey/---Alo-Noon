import type {
  AuthenticationAbortSignal,
  AuthenticationDeliveryResult,
  ResolvedAuthenticationCredential,
} from './auth-delivery'
import type { MessageTemplatePurpose } from './message-template'

/**
 * Sending a customer an ordinary message.
 *
 * Deliberately separate from the one-time-code path even though both end up as
 * a POST to the same gateway. What differs is everything around the transport:
 * a code is rate-limited per phone, per IP and per tenant, lives inside a
 * challenge with an expiry, and must never be logged; an order notification has
 * none of that and instead must not be sent twice for the same order step. One
 * interface serving both would carry the union of two sets of rules and honour
 * neither.
 *
 * The result type is shared with OTP delivery because the question a gateway
 * answers is the same one: did it take the message, and is trying again worth
 * anything.
 */
export interface TextMessageRequest {
  readonly mobileE164: string
  /** Fully rendered. Templates are resolved before a provider is ever chosen. */
  readonly body: string
  readonly senderReference: string
  readonly idempotencyKey: string
  readonly timeoutMs: number
  readonly signal: AuthenticationAbortSignal
  readonly credential: ResolvedAuthenticationCredential
}

export interface TextMessageProvider {
  readonly code: string
  sendText(request: TextMessageRequest): Promise<AuthenticationDeliveryResult>
}

/**
 * Which message an order event asks for.
 *
 * An event with no entry here is not an error — most domain events are not
 * things a customer wants a text about. Returning undefined is how the
 * publisher says "nothing to send", which keeps the decision in one readable
 * table instead of spread across the dispatcher.
 */
const ORDER_EVENT_PURPOSES: Readonly<Record<string, MessageTemplatePurpose>> = {
  'order.confirmed': 'ORDER_ACCEPTED',
  'order.in_fulfillment': 'ORDER_READY',
  'order.completed': 'ORDER_COMPLETED',
  'order.cancelled': 'ORDER_CANCELLED',
}

export function notificationPurposeForEvent(
  eventName: string,
  payload: Readonly<Record<string, unknown>>,
): MessageTemplatePurpose | undefined {
  if (eventName === 'order.production_advanced') {
    // Production has several steps and only one of them is news to a customer.
    // Telling them the dough was scheduled would be noise they pay us to send.
    return payload['toState'] === 'HANDED_OFF' ? 'ORDER_OUT_FOR_DELIVERY' : undefined
  }
  return ORDER_EVENT_PURPOSES[eventName]
}
