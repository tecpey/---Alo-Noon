/**
 * Presentation helpers shared by the admin pages.
 *
 * Money arrives as an unsigned decimal string of IRR minor units, deliberately
 * never a number, and is grouped for reading without ever being parsed: an order
 * total in Rial can exceed the float-safe range, and a dashboard that rounds
 * revenue is worse than one that shows nothing.
 */
export interface DisplayMoney {
  amount: string
  currency: string
}

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

function toPersianDigits(value: string): string {
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

export function formatMoney(money: DisplayMoney | undefined): string {
  if (!money) return '—'
  return `${toPersianDigits(groupDigits(money.amount))} ریال`
}

/**
 * Money that may legitimately be negative — a ledger balance, or a gap between
 * two figures that should agree.
 *
 * `formatMoney` clamps, because a negative order total is a data fault rather
 * than a number to show. Here the sign is the whole point: a reconciliation gap
 * that lost its minus would read as a surplus.
 */
export function formatSignedMoney(money: DisplayMoney | undefined): string {
  if (!money) return '—'
  const negative = money.amount.startsWith('-')
  const digits = toPersianDigits(groupDigits(negative ? money.amount.slice(1) : money.amount))
  return `${negative ? '−' : ''}${digits} ریال`
}

export function formatCount(value: number): string {
  return toPersianDigits(groupDigits(String(Math.trunc(Math.abs(value)))))
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return '—'
  return `${toPersianDigits((rate * 100).toFixed(1))}٪`
}

/**
 * Renders an instant in the tenant's timezone. `Intl` is used rather than a
 * hand-rolled Jalali conversion: the panel is operational tooling, and an
 * off-by-one date on a report is a real reporting error.
 */
export function formatDateTime(iso: string | null, timeZone = 'Asia/Tehran'): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso))
}

export function formatDate(value: string, timeZone = 'Asia/Tehran'): string {
  // Daily buckets are already calendar dates in the reporting timezone; parsing
  // them as UTC midnight and re-projecting would shift them by a day.
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric', timeZone }).format(
    new Date(Date.UTC(year, month - 1, day, 12)),
  )
}

export const ORDER_STATE_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'پیش‌نویس',
  PENDING_CONFIRMATION: 'در انتظار تأیید',
  CONFIRMED: 'تأییدشده',
  IN_FULFILLMENT: 'در حال انجام',
  CANCEL_REQUESTED: 'درخواست لغو',
  DELIVERY_FAILED: 'تحویل ناموفق',
  COMPLETED: 'تکمیل‌شده',
  CANCELLED: 'لغوشده',
}

export const PAYMENT_STATE_LABELS: Readonly<Record<string, string>> = {
  NOT_STARTED: 'شروع‌نشده',
  PENDING: 'در انتظار',
  PAID: 'پرداخت‌شده',
  REFUND_PENDING: 'در انتظار بازگشت',
  REFUNDED: 'بازگشت‌داده‌شده',
}

export const PRODUCTION_STATE_LABELS: Readonly<Record<string, string>> = {
  NOT_REQUIRED: 'بدون نیاز',
  UNSCHEDULED: 'زمان‌بندی‌نشده',
  SCHEDULED: 'زمان‌بندی‌شده',
  IN_PRODUCTION: 'در حال تولید',
  READY: 'آماده',
  HANDED_OFF: 'تحویل به پیک',
}

export const DELIVERY_STATE_LABELS: Readonly<Record<string, string>> = {
  NOT_REQUIRED: 'بدون نیاز',
  UNASSIGNED: 'بدون پیک',
  ASSIGNED: 'پیک تعیین‌شده',
  PICKED_UP: 'دریافت‌شده',
  OUT_FOR_DELIVERY: 'در مسیر',
  DELIVERED: 'تحویل‌شده',
  FAILED: 'ناموفق',
}

/** An unmapped state still shows its code; hiding it would hide a schema change. */
export function label(labels: Readonly<Record<string, string>>, code: string): string {
  return labels[code] ?? code
}

/** The last `days` full days up to now, as the closed-open range the API wants. */
export function recentRange(days: number, now = new Date()): { from: string; to: string } {
  const to = new Date(now.getTime() + 60_000)
  const from = new Date(to.getTime() - days * 86_400_000)
  return { from: from.toISOString(), to: to.toISOString() }
}

/**
 * Catalogue lifecycle and availability, in the words an operator uses.
 *
 * "بازنشسته" is terminal in both: the panel says so where the choice is made,
 * because the API's refusal to undo it arrives too late to be useful.
 */
export const PRODUCT_LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'پیش‌نویس',
  ACTIVE: 'فعال',
  SUSPENDED: 'متوقف',
  RETIRED: 'بازنشسته',
}

export const OFFERING_AVAILABILITY_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'پیش‌نویس',
  AVAILABLE: 'در دسترس',
  PAUSED: 'متوقف',
  SOLD_OUT: 'تمام‌شده',
  RETIRED: 'بازنشسته',
}

export const FULFILLMENT_CLASS_LABELS: Readonly<Record<string, string>> = {
  SIGNATURE_FRESH: 'تازه‌پخت',
  PACKAGED_TRADITIONAL: 'بسته‌بندی سنتی',
  PACKAGED_FANTASY: 'بسته‌بندی فانتزی',
  PACKAGED_DIETARY: 'بسته‌بندی رژیمی',
  LIMITED_EDITION: 'محدود',
}

export const BRANCH_STATUS_LABELS: Readonly<Record<string, string>> = {
  ONBOARDING: 'در حال راه‌اندازی',
  ACTIVE: 'فعال',
  TEMPORARILY_SUSPENDED: 'موقتاً متوقف',
  CLOSED: 'بسته',
}
