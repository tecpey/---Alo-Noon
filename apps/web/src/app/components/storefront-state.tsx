'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * What the customer has picked, and what they are looking at.
 *
 * Both live here because both are answers to the same question — what should
 * this page be showing right now — and splitting them into two providers would
 * mean two trees re-rendering for one interaction.
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
  readonly lines: ReadonlyMap<string, number>
  readonly count: number
  /** Bumps on every add, so the badge can react even to a repeat of the same bread. */
  readonly pulse: number
  add: (slug: string) => void
  remove: (slug: string) => void
  /** The selected category chip. `all` shows everything. */
  readonly category: string
  selectCategory: (id: string) => void
  readonly drawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
}

const StorefrontContext = createContext<StorefrontState | null>(null)

export function StorefrontProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [pulse, setPulse] = useState(0)
  const [category, setCategory] = useState('all')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const add = useCallback((slug: string) => {
    setLines((current) => {
      const next = new Map(current)
      next.set(slug, (next.get(slug) ?? 0) + 1)
      return next
    })
    setPulse((value) => value + 1)
  }, [])

  const remove = useCallback((slug: string) => {
    setLines((current) => {
      const next = new Map(current)
      const quantity = (next.get(slug) ?? 0) - 1
      if (quantity > 0) next.set(slug, quantity)
      else next.delete(slug)
      return next
    })
  }, [])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const value = useMemo<StorefrontState>(() => {
    let count = 0
    for (const quantity of lines.values()) count += quantity
    return {
      lines,
      count,
      pulse,
      add,
      remove,
      category,
      selectCategory: setCategory,
      drawerOpen,
      openDrawer,
      closeDrawer,
    }
  }, [lines, pulse, add, remove, category, drawerOpen, openDrawer, closeDrawer])

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>
}

export function useStorefront(): StorefrontState {
  const state = useContext(StorefrontContext)
  if (!state) throw new Error('useStorefront must be used inside a StorefrontProvider')
  return state
}
