'use server'

import { forgetWebPushDevice, registerWebPushDevice, webPushKey } from './shop-api'

/**
 * Subscribing this browser to order notifications, from the browser's side.
 *
 * Server actions rather than a `fetch` from the page, because the session
 * cookie is `httpOnly` — deliberately, so no script on the page can read it —
 * and the API needs it to know whose browser this is. There is no route from
 * the browser to the API that carries a session; this is it.
 *
 * Nothing here decides anything. The API owns the device row and the
 * subscription's validity; these carry the answer back in a shape a component
 * can act on without knowing about envelopes.
 */

export interface WebPushKeyOutcome {
  /**
   * `null` means this deployment has no VAPID keys, and is different from a
   * failure: the caller must not prompt. On most browsers a notification
   * permission once refused cannot be asked for again, so a prompt that could
   * never have worked costs the customer the chance to say yes later.
   */
  publicKey: string | null
}

export async function webPushKeyAction(): Promise<WebPushKeyOutcome> {
  const result = await webPushKey()
  // A failure is treated as "not configured" for the same reason: a browser
  // that cannot reach the key must not spend the one prompt it gets.
  return { publicKey: result.ok ? result.data.publicKey : null }
}

export interface SubscribeOutcome {
  ok: boolean
}

export async function subscribeWebPushAction(subscription: {
  endpoint: string
  keys: { p256dh: string; auth: string }
}): Promise<SubscribeOutcome> {
  const result = await registerWebPushDevice(subscription)
  return { ok: result.ok }
}

/**
 * Forgetting this browser.
 *
 * Called when the customer turns notifications off, and deliberately not on
 * sign-out: the row is per browser, and the next person to sign in on the same
 * browser takes it over, which is what the API does with the endpoint anyway.
 */
export async function unsubscribeWebPushAction(endpoint: string): Promise<SubscribeOutcome> {
  const result = await forgetWebPushDevice(endpoint)
  return { ok: result.ok }
}
