'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Registers the service worker, and offers to install the shop.
 *
 * One component for both because they are one decision: whether this browser is
 * being treated as an app or as a page. Splitting them would mean two client
 * components mounted in the root layout to do adjacent halves of the same job.
 */

/**
 * The event Chrome fires when it has decided the shop is installable. Typed
 * here because it is not in the DOM library — it is a Chromium extension, which
 * is also why every use of it below is guarded.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Remembers a "no" for a while, so it is asked once and not on every visit. */
const DISMISSED_KEY = 'alonoon.install.dismissed'
const DISMISSAL_DAYS = 60

/** The panels are tools people are given, not shops they choose to install. */
const PANEL_PREFIXES = ['/admin', '/bakery']

export function ProgressiveApp() {
  const pathname = usePathname()
  const [available, setAvailable] = useState<InstallPromptEvent | null>(null)
  const [asking, setAsking] = useState(false)

  /**
   * Registration, after the page is usable.
   *
   * On `load` rather than on mount: registering a worker starts a download and
   * a script evaluation, and doing that while the first paint is still settling
   * spends a customer's connection on a file they will not need until their
   * second visit.
   *
   * Development is skipped deliberately. A worker that outlives a dev server
   * serves assets from a build that no longer exists, and the hour lost to
   * that is always somebody else's.
   */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const register = () => {
      // Nothing is done with the failure. A browser that refuses to register —
      // a private window, a locked-down profile, storage that is full — still
      // has a working shop, and telling somebody about it would be reporting a
      // problem they do not have.
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
    }

    if (document.readyState === 'complete') {
      register()
      return
    }
    window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Held rather than fired. Chrome's own banner is suppressed by this call,
      // which is the point: the shop asks at a moment it chooses, in Persian,
      // instead of the browser asking in the middle of somebody reading a price.
      event.preventDefault()
      if (dismissedRecently()) return
      setAvailable(event as InstallPromptEvent)
    }
    // Once installed the offer is meaningless, and leaving it up after somebody
    // accepted is the software not noticing it got what it asked for.
    const onInstalled = () => setAvailable(null)

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!available || asking) return
    setAsking(true)
    try {
      await available.prompt()
      await available.userChoice
    } catch {
      // The browser refused to show it — usually because it was already shown.
      // Either way the offer is spent.
    }
    // Spent either way: the event cannot be used twice, whatever they chose.
    setAvailable(null)
    setAsking(false)
  }, [available, asking])

  const dismiss = useCallback(() => {
    rememberDismissal()
    setAvailable(null)
  }, [])

  if (!available) return null
  if (PANEL_PREFIXES.some((prefix) => pathname?.startsWith(prefix))) return null

  return (
    <aside className="install-offer" aria-label="نصب الو نون">
      <div className="install-offer__text">
        <strong>الو نون را نصب کنید</strong>
        <span>از صفحهٔ اصلی گوشی، بدون مرورگر — سریع‌تر باز می‌شود.</span>
      </div>
      <div className="install-offer__actions">
        <button className="an-button" type="button" onClick={install} disabled={asking}>
          نصب
        </button>
        <button
          className="install-offer__decline"
          type="button"
          onClick={dismiss}
          aria-label="بعداً، این پیشنهاد را ببند"
        >
          بعداً
        </button>
      </div>
    </aside>
  )
}

/**
 * Whether they have said no lately.
 *
 * Wrapped because `localStorage` throws outright in some privacy modes rather
 * than returning nothing, and a shop that fails to render over a dismissed
 * banner has its priorities backwards. An unreadable store means "not
 * dismissed", which at worst offers once more.
 */
function dismissedRecently(): boolean {
  try {
    const stored = window.localStorage.getItem(DISMISSED_KEY)
    if (!stored) return false
    const at = Number(stored)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < DISMISSAL_DAYS * 86_400_000
  } catch {
    return false
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Then it is asked again next time, which is a small cost and the only
    // alternative to keeping state somewhere it does not belong.
  }
}
