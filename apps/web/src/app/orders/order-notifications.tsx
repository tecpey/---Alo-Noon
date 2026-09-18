'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  subscribeWebPushAction,
  unsubscribeWebPushAction,
  webPushKeyAction,
} from '../../lib/push-actions'

/**
 * Offering to tell the customer when the bread moves.
 *
 * ## Why it is on this screen and not the first one
 *
 * A permission prompt at first launch is asking a stranger for something before
 * they know what it is for, and it is asked once: most browsers treat a refusal
 * as final and will not raise the prompt again, so a badly timed ask costs the
 * customer the option permanently. It appears here, above a live order, because
 * that is the moment the request explains itself — somebody looking at "the
 * courier is on the way" already wants to know when it arrives.
 *
 * ## What it is worth
 *
 * Every order message this replaces is a paid text message. And on an iPhone it
 * is not a saving, it is the only channel there is: Apple does not accept
 * Iranian developer enrolments, so there is no App Store build, and the shop
 * added to a home screen is the whole of what a customer can install.
 *
 * ## What it refuses to do
 *
 * It renders nothing at all unless a prompt could work *and* would be answered
 * usefully: no service worker, no push support, no VAPID key on this
 * deployment, a permission already refused — each of those is a case where the
 * honest thing is to be absent rather than to show a control that does nothing.
 */

type Stance =
  /** Still working out whether any of this is possible. */
  | 'unknown'
  /** Nothing to show: unsupported, unconfigured, refused, or already on. */
  | 'silent'
  /** The invitation, which is the only state with a control in it. */
  | 'offer'
  | 'asking'
  /** Just turned on, so the customer sees their answer took effect. */
  | 'on'
  | 'failed'

export function OrderNotifications() {
  const [stance, setStance] = useState<Stance>('unknown')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      if (!supported()) return
      const { publicKey } = await webPushKeyAction()
      // No pair configured. Not an error and not worth a word to the customer:
      // there is nothing they could do about it, and asking for a permission
      // that cannot be used would spend the one prompt this browser gives.
      if (!publicKey || cancelled) return

      if (Notification.permission === 'denied') {
        if (!cancelled) setStance('silent')
        return
      }

      if (Notification.permission === 'granted') {
        // Already said yes, on this browser or a previous visit. Re-subscribing
        // on every visit is how the registration repairs itself: the server
        // stops trusting a device nobody has confirmed in three months, and a
        // subscription the browser quietly replaced would otherwise never be
        // heard from again.
        const ok = await enable(publicKey)
        if (!cancelled) setStance(ok ? 'silent' : 'failed')
        return
      }

      if (!cancelled) setStance('offer')
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const turnOn = useCallback(async () => {
    setStance('asking')
    const { publicKey } = await webPushKeyAction()
    if (!publicKey) {
      setStance('silent')
      return
    }

    let permission: NotificationPermission
    try {
      permission = await Notification.requestPermission()
    } catch {
      setStance('failed')
      return
    }
    if (permission !== 'granted') {
      // Including "dismissed", which most browsers report as `default`. Either
      // way the offer is spent for this visit; pressing again would show
      // nothing, and a control that does nothing is worse than none.
      setStance('silent')
      return
    }

    setStance((await enable(publicKey)) ? 'on' : 'failed')
  }, [])

  if (stance === 'unknown' || stance === 'silent') return null

  if (stance === 'on') {
    // Shown only to somebody who just pressed the button. A customer who said
    // yes on a previous visit is left alone: the re-subscription above is
    // housekeeping, and announcing it every time they open their orders would
    // be the software congratulating itself.
    return (
      <p className="notify-offer__on" role="status">
        از این پس وضعیت سفارش را روی همین گوشی اعلام می‌کنیم.
      </p>
    )
  }

  if (stance === 'failed') {
    return (
      <p className="notify-offer__failed" role="status">
        روشن‌کردن اعلان‌ها ممکن نشد. پیامک وضعیت سفارش همچنان برایتان می‌آید.
      </p>
    )
  }

  return (
    <aside className="notify-offer" aria-label="اعلان وضعیت سفارش">
      <div className="notify-offer__text">
        <strong>وقتی نان راه افتاد خبرتان کنیم؟</strong>
        <span>اعلان روی همین گوشی، بدون باز کردن برنامه.</span>
      </div>
      <button className="an-button" type="button" onClick={turnOn} disabled={stance === 'asking'}>
        {stance === 'asking' ? 'در حال روشن‌کردن…' : 'بله، خبرم کن'}
      </button>
    </aside>
  )
}

/**
 * Whether a prompt could work at all.
 *
 * All four are checked because they are genuinely independent: an iPhone before
 * iOS 16.4 has service workers and no `PushManager`, the same iPhone has
 * `PushManager` only once the shop is added to the home screen, and a private
 * window can have every API present and refuse to register a worker.
 */
function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/**
 * Subscribes this browser and tells the server about it.
 *
 * The awkward part is the existing subscription. A browser keeps one per
 * origin, bound to the key it was made with, and `subscribe` throws rather than
 * replacing it if the key has changed — which happens after a VAPID rotation
 * and leaves every installed copy of the shop permanently unable to
 * re-subscribe. So an existing subscription made with a different key is
 * dropped first.
 */
async function enable(publicKey: string): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()

    if (existing && !madeWith(existing, publicKey)) {
      await existing.unsubscribe()
      // The server's row is addressed by the endpoint, and that endpoint is
      // about to stop existing. Told now rather than left to be discovered by a
      // message that is thrown away.
      await unsubscribeWebPushAction(existing.endpoint).catch(() => undefined)
    }

    const subscription =
      existing && madeWith(existing, publicKey)
        ? existing
        : await registration.pushManager.subscribe({
            // Not optional in practice: every browser refuses a subscription
            // without it, and Chrome has required it since it stopped accepting
            // silent pushes.
            userVisibleOnly: true,
            applicationServerKey: decodeBase64url(publicKey),
          })

    const keys = readKeys(subscription)
    if (!keys) return false
    const { ok } = await subscribeWebPushAction({ endpoint: subscription.endpoint, keys })
    return ok
  } catch {
    // A worker that never became ready, storage that is full, a browser that
    // refuses in a private window. None of it is worth an error page: the SMS
    // still carries every message, which is exactly what happened before.
    return false
  }
}

/** Whether this subscription belongs to the key we are configured with. */
function madeWith(subscription: PushSubscription, publicKey: string): boolean {
  const applied = subscription.options?.applicationServerKey
  if (!applied) return false
  const theirs = new Uint8Array(applied)
  const ours = decodeBase64url(publicKey)
  return theirs.length === ours.length && theirs.every((octet, index) => octet === ours[index])
}

/**
 * The two keys, as the server needs them.
 *
 * `toJSON` is used rather than `getKey`, because it already hands them back as
 * unpadded base64url — which is the format the contract accepts, and the
 * conversion is the kind of step that silently produces a key one octet short.
 */
function readKeys(subscription: PushSubscription): { p256dh: string; auth: string } | null {
  const json = subscription.toJSON()
  const p256dh = json.keys?.['p256dh']
  const auth = json.keys?.['auth']
  return p256dh && auth ? { p256dh, auth } : null
}

/**
 * base64url to octets, for `applicationServerKey`.
 *
 * `atob` wants standard base64 and the key is URL-safe, so the two substituted
 * characters are put back. Padding is added because some browsers' `atob`
 * refuses a length that is not a multiple of four, and a key rejected here
 * means no subscription at all.
 */
function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  // The buffer is named explicitly because `applicationServerKey` will not take
  // a view over a `SharedArrayBuffer`, and an unannotated `Uint8Array` is
  // typed as a view over either.
  const octets = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    octets[index] = binary.charCodeAt(index)
  }
  return octets
}
