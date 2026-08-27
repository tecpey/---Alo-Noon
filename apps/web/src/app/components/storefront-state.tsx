'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

import { ALL_CATEGORIES, type ShelfProduct } from '../../lib/catalog-view'

/**
 * What the customer has picked, and what they are looking at.
 *
 * Both live here because both are answers to the same question — what should
 * this page be showing right now — and splitting them into two providers would
 * mean two trees re-rendering for one interaction.
 *
 * Lines are keyed by offering id, which is what the server-side cart keys on
 * too. The same bread at two branches is two offerings at two prices, so a
 * basket keyed by slug would be a basket that cannot say which bakery it means.
 *
 * The basket is honest about what it is: state in a React tree. It is not yet
 * the server-side cart, which already exists with versioned optimistic
 * concurrency and capacity arbitration and which the mobile app talks to.
 * Wiring this page to it is a data-source change behind this interface, which
 * is why it is a context rather than a `useState` three components up.
 *
 * It deliberately does not persist. A basket that survives a refresh implies a
 * basket the server knows about, and a customer who came back to find their
 * bread waiting would be right to expect it to still be reserved. Nothing is
 * reserved.
 */
interface StorefrontState {
  /** Offering id to quantity. */
  readonly lines: ReadonlyMap<string, number>
  readonly count: number
  /** Bumps on every add, so the badge can react even to a repeat of the same bread. */
  readonly pulse: number
  /** Every bread on the page, by offering id, so the basket can price its lines. */
  readonly catalog: ReadonlyMap<string, ShelfProduct>
  add: (offeringId: string) => void
  remove: (offeringId: string) => void
  /** The selected category chip. `all` shows everything. */
  readonly category: string
  selectCategory: (code: string) => void
  readonly drawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
}

const StorefrontContext = createContext<StorefrontState | null>(null)

export function StorefrontProvider({
  products,
  children,
}: {
  /** Everything on sale in this city, flattened across the shelves. */
  products: readonly ShelfProduct[]
  children: ReactNode
}) {
  const [lines, setLines] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [pulse, setPulse] = useState(0)
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const add = useCallback((offeringId: string) => {
    setLines((current) => {
      const next = new Map(current)
      next.set(offeringId, (next.get(offeringId) ?? 0) + 1)
      return next
    })
    setPulse((value) => value + 1)
  }, [])

  const remove = useCallback((offeringId: string) => {
    setLines((current) => {
      const next = new Map(current)
      const quantity = (next.get(offeringId) ?? 0) - 1
      if (quantity > 0) next.set(offeringId, quantity)
      else next.delete(offeringId)
      return next
    })
  }, [])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const catalog = useMemo(
    () => new Map(products.map((product) => [product.offeringId, product])),
    [products],
  )

  const value = useMemo<StorefrontState>(() => {
    let count = 0
    for (const quantity of lines.values()) count += quantity
    return {
      lines,
      count,
      pulse,
      catalog,
      add,
      remove,
      category,
      selectCategory: setCategory,
      drawerOpen,
      openDrawer,
      closeDrawer,
    }
  }, [lines, pulse, catalog, add, remove, category, drawerOpen, openDrawer, closeDrawer])

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>
}

export function useStorefront(): StorefrontState {
  const state = useContext(StorefrontContext)
  if (!state) throw new Error('useStorefront must be used inside a StorefrontProvider')
  return state
}
