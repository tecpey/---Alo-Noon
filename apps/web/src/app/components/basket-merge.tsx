'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { mergeBasketAction } from '../../lib/shop-actions'
import { readStoredBasket, writeStoredBasket } from '../../lib/basket-storage'

/**
 * Carries a browser basket onto the server cart, on any page that needs it.
 *
 * This used to live only inside the storefront's state provider, which meant
 * checkout — a page with no shelves and so no provider — never merged. A
 * customer who filled a basket, was sent through sign-in and landed back on
 * checkout was told their basket was empty while it sat untouched in their
 * browser. Merging is a property of "a signed-in page loaded", not of "the
 * storefront rendered", so it lives in a component any page can mount.
 *
 * It renders nothing until something goes wrong, and refreshes the route on
 * success so the server component re-reads the cart it just filled.
 */
export function BasketMerge({ signedIn }: { signedIn: boolean }) {
  const router = useRouter()
  const done = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!signedIn || done.current) return
    done.current = true

    const stored = readStoredBasket()
    if (stored.length === 0) return

    void mergeBasketAction(stored).then((result) => {
      // The browser copy has done its job. Leaving it would merge again on the
      // next visit and resurrect bread the customer has since removed.
      writeStoredBasket(null)
      setError(result.error)
      if (result.cart) router.refresh()
    })
  }, [signedIn, router])

  if (!error) return null
  return (
    <p className="checkout__error" role="status">
      {error}
    </p>
  )
}
