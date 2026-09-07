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
export function tomanDigits(amountRial: bigint): string {
  return toPersianDigits(groupDigits(rialToToman(amountRial)))
}

/**
 * The same number with its unit attached.
 *
 * Two functions rather than one with a flag, because the two callers are
 * different in kind: a sentence this code writes needs the word, and a message
 * template an operator wrote already has the word in it — appending a second
 * one would produce «۵۰٬۰۰۰ تومان تومان».
 */
export function formatToman(amountRial: bigint): string {
  return `${toPersianDigits(groupDigits(rialToToman(amountRial)))} تومان`
}

/**
 * Rial to Toman keeping the remainder, for the numbers this system *derives*
 * rather than the ones a person typed.
 *
 * The strict conversion above is right for a price: prices are entered in
 * Toman, so a price that is not a whole Toman is a fault worth refusing. It is
 * wrong for a settlement figure. A commission is `subtotal × basisPoints ÷
 * 10000`, and that division lands on a whole Toman only by coincidence — a
 * 250,000 Rial subtotal at 3.33٪ is 8,325 Rial, which is 832٫5 Toman. So is the
 * bakery's share of the same order, and so is every column that sums either of
 * them. Refusing those would blank a financial report rather than protect it.
 *
 * The remainder is one digit by construction: a Toman is exactly ten Rial, so
 * the only fraction that can exist is halves. It is printed with the Persian
 * decimal separator, and only when it is there — a whole amount renders exactly
 * as the strict conversion would, so the two never disagree on the same number.
 *
 * Still integer arithmetic throughout. The point of holding money in BigInt is
 * lost the moment a report divides.
 */
export function tomanExactDigits(amountRial: bigint): string {
  if (amountRial < 0n) {
    throw new DomainError('INVALID_AMOUNT', 'A negative amount cannot be shown as Toman')
  }
  const digits = amountRial.toString().padStart(2, '0')
  const whole = groupDigits(digits.slice(0, -1))
  const remainder = digits.slice(-1)
  return remainder === '0' ? whole : `${whole}٫${remainder}`
}

/** `tomanExactDigits` in Persian digits, with the unit word. */
export function formatTomanExact(amountRial: bigint): string {
  return `${toPersianDigits(tomanExactDigits(amountRial))} تومان`
}

/**
 * Persian and Arabic-Indic digits folded to Latin, and nothing else touched.
 *
 * Every field in this system that reads a number a person typed needs this
 * first. A customer on a Persian keyboard types ۶۰۳۷۹۹۱۲۳۴۵۶۴۵۶۷ for a card
 * number, and refusing it as "not sixteen digits" is the software failing to
 * read its own language.
 *
 * Separators are left alone: what counts as one differs by field — a card
 * number tolerates spaces and dashes, an amount tolerates thousands marks — and
 * folding both here would let a dash through into an amount.
 */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
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
  const latin = toLatinDigits(raw).replace(/[\s,٬،_]/g, '')
  if (!/^\d{1,15}$/.test(latin)) return null
  const toman = BigInt(latin)
  if (toman <= 0n) return null
  return toman * 10n
}
