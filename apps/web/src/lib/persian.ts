/**
 * Persian number presentation, shared by the storefront and the admin panel.
 *
 * Money is never parsed into a JavaScript number on the way through here. An
 * order total in Rial can exceed the float-safe range, and a price that rounds
 * on its way to a customer's screen is worse than one that fails to render.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

export function toPersianDigits(value: string): string {
  return value.replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]!)
}

/**
 * Groups an arbitrarily long digit string in threes, right to left.
 *
 * Stays in Latin digits throughout; every caller converts afterwards, so a
 * Persian digit returned from here would slip past that conversion untouched.
 */
export function groupDigits(digits: string): string {
  const normalized = digits.replace(/^0+(?=\d)/, '')
  let grouped = ''
  for (let index = normalized.length; index > 0; index -= 3) {
    const start = Math.max(0, index - 3)
    grouped = normalized.slice(start, index) + (grouped ? '٬' + grouped : '')
  }
  return grouped || '0'
}

/**
 * A price in Toman, from an amount held in Rial.
 *
 * Customers say and read Toman; the ledger keeps Rial, because that is the
 * currency the payment gateways settle in. The conversion is a digit shift
 * rather than a division, so it stays exact at any size.
 *
 * A Rial amount that is not a whole Toman would lose its last digit silently,
 * so it does not: such an amount is a pricing fault, and rendering it rounded
 * would hide the fault behind a plausible number.
 */
export function formatToman(amountRial: string): string {
  const digits = amountRial.replace(/^-/, '')
  if (!/^\d+$/.test(digits)) return '—'
  if (digits.length > 1 && !digits.endsWith('0')) return '—'
  const toman = digits.length > 1 ? digits.slice(0, -1) : '0'
  return `${toPersianDigits(groupDigits(toman))} تومان`
}
