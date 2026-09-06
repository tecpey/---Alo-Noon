import { DomainError } from './errors'

/**
 * The unit customers actually speak, printed from the unit the ledger keeps.
 *
 * Every amount in this system is stored and moved in Rial, because that is what
 * the gateways settle in and what the tax authority reads. Nobody in Iran says
 * Rial out loud. A price tag, a refusal message and a text message all have to
 * say Toman or they will be misread by a factor of ten — which, on a screen
 * asking somebody to confirm a payment, is not a cosmetic problem.
 *
 * The conversion is a digit shift rather than a division, so it stays exact at
 * any size. A Rial amount that is not a whole Toman is a pricing fault rather
 * than something to round away: rounding would hide the fault behind a
 * plausible number, and the number is money.
 */
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

export function toPersianDigits(value: string): string {
  return value.replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]!)
}

/** Groups a digit string in threes, right to left, in Latin digits. */
export function groupDigits(digits: string): string {
  const normalized = digits.replace(/^0+(?=\d)/, '')
  let grouped = ''
  for (let index = normalized.length; index > 0; index -= 3) {
    const start = Math.max(0, index - 3)
    grouped = normalized.slice(start, index) + (grouped ? '٬' + grouped : '')
  }
  return grouped || '0'
}

/** Rial to Toman, exactly, as a Latin digit string. */
export function rialToToman(amountRial: bigint): string {
  if (amountRial < 0n) {
    throw new DomainError('INVALID_AMOUNT', 'A negative amount cannot be shown as Toman')
  }
  const digits = amountRial.toString()
  if (digits.length > 1 && !digits.endsWith('0')) {
    throw new DomainError(
      'INVALID_AMOUNT',
      'A Rial amount that is not a whole Toman cannot be shown',
    )
  }
  return digits.length > 1 ? digits.slice(0, -1) : '0'
}

/**
 * A Rial amount as a Persian Toman phrase, ready to put in a sentence.
 *
 * Used by every customer-facing message the domain writes. The suffix is part of
 * it on purpose: a bare number in a text message about money is a number the
 * reader has to guess the unit of.
 */
export function formatToman(amountRial: bigint): string {
  return `${toPersianDigits(groupDigits(rialToToman(amountRial)))} تومان`
}

/**
 * Toman as typed by a person, back to Rial.
 *
 * Accepts Persian and Arabic-Indic digits, thousands separators of every kind
 * anybody uses, and surrounding space. Returns null rather than throwing for
 * anything else, because this reads a form field and a refusal is an answer the
 * screen shows rather than a fault.
 */
export function parseTomanToRial(raw: string): bigint | null {
  const latin = raw
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[\s,٬،_]/g, '')
  if (!/^\d{1,15}$/.test(latin)) return null
  const toman = BigInt(latin)
  if (toman <= 0n) return null
  return toman * 10n
}
