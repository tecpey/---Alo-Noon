/**
 * Pure helpers behind the storefront's Server Actions.
 *
 * They live outside `shop-actions.ts` because a `'use server'` module may only
 * export async functions — which also means anything exported from there
 * becomes a callable endpoint, and nothing in it can be unit tested directly.
 */

/** Persian and Arabic-Indic digits, mapped back to the ones a parser accepts. */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
}

/**
 * An Iranian mobile number in the +98 form the API demands, or null.
 *
 * Customers type `0912…`, `+98912…`, `98912…`, with spaces, with dashes, and
 * often in Persian digits. Accepting one spelling and refusing the rest is
 * refusing customers over a formatting preference — and this is the first field
 * anybody fills in, so it is the cheapest possible place to lose them.
 */
export function normalizeMobile(raw: string): string | null {
  const latin = toLatinDigits(raw).replace(/[^\d+]/g, '')
  const digits = latin.startsWith('+98')
    ? latin.slice(3)
    : latin.startsWith('98')
      ? latin.slice(2)
      : latin.startsWith('0')
        ? latin.slice(1)
        : latin
  return /^9\d{9}$/.test(digits) ? `+98${digits}` : null
}

/** The six digits of a one-time code, however they were typed. */
export function normalizeOtpCode(raw: string): string {
  return toLatinDigits(raw).replace(/\D/g, '').slice(0, 8)
}
