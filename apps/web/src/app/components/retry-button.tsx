'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/**
 * "Try again", meaning it.
 *
 * A link back to the same page is not a retry: the router may satisfy it from
 * what it already has, and the customer presses a button that visibly does
 * nothing. `router.refresh()` re-runs the server render, which is where the
 * failed call actually lives.
 *
 * While it is running the button says so and refuses a second press, because
 * the state it is recovering from is one where the API was slow or down — the
 * exact case where somebody presses three more times.
 */
export function RetryButton({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      className="an-button an-button--quiet"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? 'در حال تلاش…' : children}
    </button>
  )
}
