/**
 * Persian number presentation for the storefront and the admin panel.
 *
 * The arithmetic and the wording live in `@alo-noon/domain`, because the API
 * writes the same sentences into text messages and a limit quoted two ways is a
 * limit that will eventually disagree with itself. What is here is the part a
 * renderer needs and a message writer does not: an amount that arrives from the
 * network malformed must draw a dash, not throw inside a page.
 *
 * Money is never parsed into a JavaScript number on the way through. An order
 * total in Rial can exceed the float-safe range, and a price that rounds on its
 * way to a customer's screen is worse than one that fails to render.
 */
import { formatToman as tomanPhrase, groupDigits, toPersianDigits } from '@alo-noon/domain'

export { groupDigits, toPersianDigits }

/**
 * A price in Toman, from an amount held in Rial as a string.
 *
 * Draws a dash for anything that is not a whole Toman amount. The domain throws
 * on the same input, which is right where a message is being composed and wrong
 * here: a malformed price should be visibly missing on one line rather than
 * take the page down with it.
 */
export function formatToman(amountRial: string): string {
  const digits = amountRial.replace(/^-/, '')
  if (!/^\d+$/.test(digits)) return '—'
  try {
    return tomanPhrase(BigInt(digits))
  } catch {
    return '—'
  }
}

/**
 * Adds up a basket, in Rial, without ever leaving integer arithmetic.
 *
 * BigInt rather than number for the same reason the rest of this system keeps
 * money as strings: a basket is small, but the code that sums it is the code
 * that will one day sum a month of orders, and a total that silently loses
 * precision is a total somebody will act on.
 */
export function sumRial(entries: Iterable<{ priceRial: string; quantity: number }>): string {
  let total = 0n
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.priceRial)) continue
    total += BigInt(entry.priceRial) * BigInt(Math.max(0, Math.trunc(entry.quantity)))
  }
  return total.toString()
}
