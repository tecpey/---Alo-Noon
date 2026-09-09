/**
 * Turning what someone typed into what the API accepts.
 *
 * Shared because both the customer app and the courier app take the same two
 * inputs — a mobile number and a six-digit code — from the same keyboards. An
 * Iranian phone keyboard produces Persian digits by default, and a number
 * pasted from a contact card arrives as `0912...`, `+98912...`, `0098912...`,
 * or with spaces and dashes through it. Every one of those is the same person's
 * number, and a sign-in screen that refused four of the five forms would be
 * refusing people who typed their own number correctly.
 *
 * Deliberately lenient about *shape* and strict about *identity*: it will not
 * guess at a number that is not an Iranian mobile. `normalizeIranianMobile`
 * elsewhere in this package is the strict, throwing form used server-side once
 * a value has already been normalised — this is the one that faces a keyboard.
 */
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** Persian and Arabic-Indic digits to ASCII; everything else untouched. */
export function normalizeDigits(value: string): string {
  return [...value]
    .map((character) => {
      const persianIndex = PERSIAN_DIGITS.indexOf(character)
      if (persianIndex >= 0) return String(persianIndex)
      const arabicIndex = ARABIC_DIGITS.indexOf(character)
      return arabicIndex >= 0 ? String(arabicIndex) : character
    })
    .join('')
}

/**
 * An Iranian mobile in E.164, or null when what was typed is not one.
 *
 * Null rather than a throw because this runs on every keystroke of a sign-in
 * field, where "not yet a valid number" is the normal state rather than an
 * error worth reporting.
 */
export function parseIranianMobile(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/[\s()-]/g, '')

  if (/^09\d{9}$/.test(ascii)) return `+98${ascii.slice(1)}`
  if (/^9\d{9}$/.test(ascii)) return `+98${ascii}`
  if (/^\+989\d{9}$/.test(ascii)) return ascii
  if (/^00989\d{9}$/.test(ascii)) return `+${ascii.slice(2)}`
  return null
}

/** The six digits of a one-time code, or null if that is not what was typed. */
export function parseOtpCode(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/\s/g, '')
  return /^\d{6}$/.test(ascii) ? ascii : null
}
