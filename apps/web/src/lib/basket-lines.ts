import type { CartSummary } from '@alo-noon/contracts'

/**
 * The basket a visitor builds before the server knows who they are.
 *
 * The cart the API keeps belongs to a customer, and a customer only exists
 * after a one-time code has been typed. Making that the only basket would mean
 * asking for a phone number before someone may add a single loaf, which is the
 * most expensive question a shop can ask and the wrong moment to ask it. So the
 * basket starts in the browser and moves to the server at sign-in, which is
 * what every shop worth copying does.
 *
 * None of this reserves anything, and neither does the server cart — stock is
 * taken at order acceptance, and the price is only fixed once a quote is cut.
 * A basket is a list of intentions on both sides of the sign-in line.
 */

export interface BasketLine {
  readonly offeringId: string
  readonly quantity: number
}

/** Where the anonymous basket is kept. Per-origin, per-browser, and nowhere else. */
export const BASKET_STORAGE_KEY = 'alo_basket_v1'

/** One bread's worth of sanity: the API refuses anything outside this. */
const MAX_QUANTITY = 100

/**
 * Reads the stored basket, believing nothing it finds.
 *
 * Local storage is writable by anything that has run on this origin and
 * survives across deploys, so its contents are input, not state: a value from
 * an older release, a half-written string, or something a person typed into a
 * console all arrive here looking the same. Anything unrecognisable is dropped
 * rather than repaired, because a basket that silently becomes "quantity NaN"
 * fails much later and much less clearly.
 */
export function parseStoredBasket(raw: string | null): BasketLine[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const lines: BasketLine[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const { offeringId, quantity } = entry as { offeringId?: unknown; quantity?: unknown }
    if (typeof offeringId !== 'string' || offeringId.length === 0) continue
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) continue
    if (quantity < 1 || quantity > MAX_QUANTITY) continue
    // A duplicated offering would become two lines for one bread; the first
    // wins rather than the two being added together, since a tampered file
    // should not be able to inflate a quantity past the cap by repeating it.
    if (seen.has(offeringId)) continue
    seen.add(offeringId)
    lines.push({ offeringId, quantity })
  }
  return lines
}

export function serializeBasket(lines: ReadonlyMap<string, number>): string {
  return JSON.stringify([...lines].map(([offeringId, quantity]) => ({ offeringId, quantity })))
}

export function linesFromCart(cart: CartSummary | null): Map<string, number> {
  const lines = new Map<string, number>()
  for (const item of cart?.items ?? []) lines.set(item.bakeryProductOfferingId, item.quantity)
  return lines
}

/**
 * What to write to the server cart when a customer signs in holding a basket.
 *
 * The larger of the two quantities wins per bread, rather than the sum. Someone
 * who left two lavash in a cart last week and has just put two more in this
 * tab meant to buy two, not four — and a merge that inflates an order is a
 * merge that shows up as a refund. Taking the maximum is also idempotent, so a
 * sign-in that is retried after a dropped connection cannot keep growing the
 * cart.
 *
 * Only lines that would actually change the cart are returned, so a customer
 * signing in with an empty basket writes nothing at all.
 */
export function mergePlan(
  local: ReadonlyMap<string, number>,
  server: ReadonlyMap<string, number>,
): BasketLine[] {
  const plan: BasketLine[] = []
  for (const [offeringId, quantity] of local) {
    const existing = server.get(offeringId) ?? 0
    const merged = Math.min(MAX_QUANTITY, Math.max(quantity, existing))
    if (merged !== existing) plan.push({ offeringId, quantity: merged })
  }
  return plan
}
