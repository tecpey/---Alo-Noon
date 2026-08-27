import { toPersianDigits } from './persian'

/**
 * Minutes, said the way a person would say them.
 *
 * Always rounded down, and kept in minutes below two hours. Both are the same
 * decision: these numbers say how long bread stays good, and rounding 90
 * minutes up to "۲ ساعت" would tell a customer their bread is fresh for half an
 * hour longer than the bakery said it was. Under-promising is the only safe
 * direction to be wrong in.
 */
export function minutes(total: number): string {
  if (total < 120) return `${toPersianDigits(String(total))} دقیقه`
  const hours = Math.floor(total / 60)
  if (hours < 48) return `${toPersianDigits(String(hours))} ساعت`
  return `${toPersianDigits(String(Math.floor(hours / 24)))} روز`
}
