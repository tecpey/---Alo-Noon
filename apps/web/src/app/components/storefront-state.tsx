'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { ALL_CATEGORIES, type ShelfProduct } from '../../lib/catalog-view'
import { linesFromCart, serializeBasket } from '../../lib/basket-lines'
import { readStoredBasket, writeStoredBasket } from '../../lib/basket-storage'
import { mergeBasketAction, setBasketQuantityAction } from '../../lib/shop-actions'

/**
 * What the customer has picked, and what they are looking at.
 *
 * The basket lives in one of two places depending on who is asking, and this is
 * the seam between them.
 *
 * Signed out, it is in the browser. The cart the API keeps belongs to a
 * customer, and a customer only exists once a one-time code has been typed —
 * making that the only basket would mean demanding a phone number before
 * someone may add a single loaf. It is persisted, so closing a tab does not
 * throw the basket away, and reconciled against the live catalog on every
 * render, so a bread that has been withdrawn quietly leaves rather than sitting
 * there un-buyable.
 *
 * Signed in, the server cart is the truth. Every change is written through a
 * Server Action and the answer replaces local state, which means the quantity
 * on screen is the quantity the API stored — including when it clamped it,
 * refused it, or someone changed the same cart from the phone app a moment ago.
 *
 * Crossing from one to the other happens once, at sign-in, and merges.
 *
 * Neither basket reserves anything. Stock is taken when an order is accepted
 * and the price is only fixed when a quote is cut; a basket is a list of
 * intentions on both sides of that line.
 */
interface StorefrontState {
  /** Offering id to quantity. */
  readonly lines: ReadonlyMap<string, number>
  readonly count: number
  /** Bumps on every add, so the badge can react even to a repeat of the same bread. */
  readonly pulse: number
  /** Every bread on the page, by offering id, so the basket can price its lines. */
  readonly catalog: ReadonlyMap<string, ShelfProduct>
  /** True while a write to the server cart is in flight. */
  readonly saving: boolean
  /** What the server refused, in Persian, or null. */
  readonly error: string | null
  add: (offeringId: string) => void
  remove: (offeringId: string) => void
  /** The selected category chip. `all` shows everything. */
  readonly category: string
  selectCategory: (code: string) => void
  /**
   * What is typed in the header's search box. Empty shows everything.
   *
   * Held here rather than in the header because the box and the shelves it
   * filters are on opposite sides of the page: the header is pinned above the
   * catalogue and neither is the other's parent.
   */
  readonly query: string
  setQuery: (value: string) => void
  readonly drawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
  /**
   * The city this shop is priced in, and the ones a customer could move to.
   *
   * Here because the header shows it and the header is a client component, and
   * because until now it showed a hard-coded «شهرتان را انتخاب کنید» to
   * somebody already shopping in Babol — the most persistent element on the
   * page, saying something untrue.
   */
  readonly cityNameFa: string | null
  readonly cities: readonly CityChoice[]
  readonly cityOpen: boolean
  openCity: () => void
  closeCity: () => void
}

/** Just enough of a city to name it and switch to it. */
export interface CityChoice {
  readonly id: string
  readonly nameFa: string
}

const StorefrontContext = createContext<StorefrontState | null>(null)

export function StorefrontProvider({
  products,
  signedIn = false,
  serverLines,
  serverVersion,
  cityNameFa = null,
  cities = [],
  children,
}: {
  /** Everything on sale in this city, flattened across the shelves. */
  products: readonly ShelfProduct[]
  /** Whether the API recognised a customer on this request. */
  signedIn?: boolean
  /** The server cart's lines, when there is one. */
  serverLines?: readonly (readonly [string, number])[]
  /** The cart version those lines came from, for optimistic concurrency. */
  serverVersion?: number
  /** The city the catalogue below was priced in, when there is one. */
  cityNameFa?: string | null
  /** Every city this shop is open in, so the header can offer a move. */
  cities?: readonly CityChoice[]
  children: ReactNode
}) {
  const [lines, setLines] = useState<ReadonlyMap<string, number>>(() => new Map(serverLines ?? []))
  const [pulse, setPulse] = useState(0)
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [query, setQuery] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [cityOpen, setCityOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const version = useRef<number | undefined>(serverVersion)
  const hydrated = useRef(false)

  const catalog = useMemo(
    () => new Map(products.map((product) => [product.offeringId, product])),
    [products],
  )

  /**
   * On first mount, take up whatever the last visit left behind.
   *
   * Signed out this restores the basket. Signed in it is a merge: a visitor who
   * filled a basket and then signed in expects to find it, and the plan for
   * that is computed on the server where the cart's real contents are known.
   *
   * It runs after mount rather than during render because the server has no
   * local storage, and reading it while rendering would make the first client
   * paint disagree with the HTML that was sent.
   */
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    const stored = readStoredBasket()
    if (!signedIn) {
      if (stored.length > 0) {
        setLines(new Map(stored.map((line) => [line.offeringId, line.quantity])))
      }
      return
    }

    if (stored.length === 0) return
    setSaving(true)
    void mergeBasketAction(stored)
      .then((result) => {
        if (result.cart) setLines(linesFromCart(result.cart))
        version.current = result.cart?.version
        setError(result.error)
        // The browser copy has done its job; leaving it would merge again on
        // the next visit and resurrect bread the customer has since removed.
        writeStoredBasket(null)
      })
      .finally(() => setSaving(false))
  }, [signedIn])

  /** Only the anonymous basket is persisted; a signed-in one lives on the server. */
  useEffect(() => {
    if (!hydrated.current || signedIn) return
    writeStoredBasket(serializeBasket(lines))
  }, [lines, signedIn])

  /**
   * Writes one quantity, optimistically for a signed-out visitor and through
   * the API for a signed-in one.
   *
   * The optimistic value is shown immediately either way, because waiting for a
   * round trip to draw a "+1" is the difference between a shop that feels alive
   * and one that feels broken. When the server answers, its numbers win.
   */
  const write = useCallback(
    (offeringId: string, quantity: number) => {
      setError(null)
      setLines((current) => {
        const next = new Map(current)
        if (quantity > 0) next.set(offeringId, quantity)
        else next.delete(offeringId)
        return next
      })
      if (!signedIn) return

      const product = catalog.get(offeringId)
      if (!product) return

      setSaving(true)
      void setBasketQuantityAction({
        offeringId,
        cityId: product.cityId,
        operationalZoneId: product.operationalZoneId,
        quantity,
        ...(version.current !== undefined && { expectedCartVersion: version.current }),
      })
        .then((result) => {
          if (result.cart) {
            setLines(linesFromCart(result.cart))
            version.current = result.cart.version
          }
          setError(result.error)
        })
        .finally(() => setSaving(false))
    },
    [signedIn, catalog],
  )

  /*
    The current quantities, mirrored so `add` can read them without a state
    updater. Reading through `setLines` would mean calling `setLines` again from
    inside an updater, and an updater that has side effects runs twice under
    StrictMode and once more on any replay — which is how a single tap becomes
    two loaves.
  */
  const linesRef = useRef(lines)
  linesRef.current = lines

  const add = useCallback(
    (offeringId: string) => {
      write(offeringId, (linesRef.current.get(offeringId) ?? 0) + 1)
      setPulse((value) => value + 1)
    },
    [write],
  )

  const remove = useCallback(
    (offeringId: string) => {
      write(offeringId, (linesRef.current.get(offeringId) ?? 0) - 1)
    },
    [write],
  )

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const openCity = useCallback(() => setCityOpen(true), [])
  const closeCity = useCallback(() => setCityOpen(false), [])

  const value = useMemo<StorefrontState>(() => {
    let count = 0
    for (const quantity of lines.values()) count += quantity
    return {
      lines,
      count,
      pulse,
      catalog,
      saving,
      error,
      add,
      remove,
      category,
      selectCategory: setCategory,
      query,
      setQuery,
      drawerOpen,
      openDrawer,
      closeDrawer,
      cityNameFa,
      cities,
      cityOpen,
      openCity,
      closeCity,
    }
  }, [
    lines,
    pulse,
    catalog,
    saving,
    error,
    add,
    remove,
    category,
    query,
    drawerOpen,
    openDrawer,
    closeDrawer,
    cityNameFa,
    cities,
    cityOpen,
    openCity,
    closeCity,
  ])

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>
}

/**
 * The storefront, when there is one.
 *
 * The provider wraps the shop and a bread's own page — the two places with a
 * catalogue to price a basket against. The tab bar is on every page, so it asks
 * this way and falls back to what the server told the layout.
 */
export function useStorefrontOptional(): StorefrontState | null {
  return useContext(StorefrontContext)
}

export function useStorefront(): StorefrontState {
  const state = useContext(StorefrontContext)
  if (!state) throw new Error('useStorefront must be used inside a StorefrontProvider')
  return state
}
