/**
 * Reading amounts back out of gateway responses.
 *
 * These live apart from any one adapter because every gateway reports a settled
 * amount and the caller compares all of them the same way. They are deliberately
 * strict: a value that is not a plain non-negative integer yields null rather
 * than a best guess, because a misparsed amount that happens to match the
 * expected one would authorise a capture on no evidence at all.
 */
const RIAL_DIGITS = /^\d{1,18}$/
// One decimal place shorter, since the value is multiplied by ten.
const TOMAN_DIGITS = /^\d{1,17}$/

function digitsOf(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null
  const raw = typeof value === 'number' ? String(value) : value.trim()
  return raw.length > 0 ? raw : null
}

/** Reads a gateway-reported Rial amount as IRR minor units. */
export function parseRialAmount(value: string | number | undefined | null): bigint | null {
  const raw = digitsOf(value)
  if (raw === null || !RIAL_DIGITS.test(raw)) return null
  return BigInt(raw)
}

/** Reads a gateway-reported Toman amount and converts it to IRR minor units. */
export function parseTomanAmount(value: string | number | undefined | null): bigint | null {
  const raw = digitsOf(value)
  if (raw === null || !TOMAN_DIGITS.test(raw)) return null
  return BigInt(raw) * 10n
}
