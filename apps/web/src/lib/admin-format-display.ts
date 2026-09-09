/**
 * Presentation helpers shared by the admin pages.
 *
 * Money arrives as an unsigned decimal string of IRR minor units, deliberately
 * never a number, and is never parsed into one: a month of a working city's
 * revenue exceeds the float-safe range, and a dashboard that rounds is worse
 * than one that shows nothing.
 *
 * It is shown in **Toman**, like every other number anybody in this system
 * reads. The panel used to print Rial while the storefront, both applications
 * and every text message printed Toman, so an operator comparing a report
 * against a customer's screen was reading the same money ten times over. The
 * conversion is the domain's, shared with the storefront, so the two cannot
 * drift apart again.
 */
import { formatTomanExact, groupDigits, toPersianDigits } from './persian'

export { groupDigits, toPersianDigits }

export interface DisplayMoney {
  amount: string
  currency: string
}

/**
 * Money on an operator's screen.
 *
 * The exact conversion, not the strict one the storefront uses for prices. What
 * this panel shows is mostly *derived* money — a commission, a bakery's share,
 * a payout total, a column of a trial balance — and a basis-point rate lands on
 * a whole Toman only by luck. The strict formatter refuses a half Toman, and a
 * refusal on this screen means a dash where a number belongs: a settlement page
 * that stops reporting looks exactly like a settlement page with nothing to
 * report.
 *
 * The sign survives, always. It has no business being here — these are
 * magnitudes — but a minus dropped on the way to a report is a debt printed as
 * a credit, and there is no reading of "safer" that gets you there.
 */
export function formatMoney(money: DisplayMoney | undefined): string {
  if (!money) return '—'
  const negative = money.amount.startsWith('-')
  const magnitude = formatTomanExact(negative ? money.amount.slice(1) : money.amount)
  return negative && magnitude !== '—' ? `−${magnitude}` : magnitude
}

/**
 * Money that may legitimately be negative — a ledger balance, or a gap between
 * two figures that should agree.
 *
 * Identical rendering to `formatMoney`, kept as its own name because the call
 * sites differ in what they are asserting: here the sign is expected, and a
 * reconciliation gap that lost its minus would read as a surplus.
 */
export const formatSignedMoney = formatMoney

export function formatCount(value: number): string {
  return toPersianDigits(groupDigits(String(Math.trunc(Math.abs(value)))))
}

/**
 * A rate as a percentage, with the Persian decimal separator.
 *
 * `toFixed` leaves an ASCII full stop behind, which next to a money column that
 * writes ۸۳۲٫۵ gives one table two different decimal marks. Substituted rather
 * than formatted through `Intl`, which would also introduce a grouping mark
 * this number never needs.
 */
export function formatPercent(rate: number | null): string {
  if (rate === null) return '—'
  return `${toPersianDigits((rate * 100).toFixed(1)).replace('.', '٫')}٪`
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

/**
 * Which steps a staff operator can take from where the order is now.
 *
 * Mirrors the domain's own rules so the panel offers only what the API will
 * accept. It is a projection, not the authority: the server checks again, and a
 * step that slipped through here still gets refused there.
 */
export function availableOrderSteps(
  state: string,
  paymentState: string,
): ReadonlyArray<{ step: string; label: string }> {
  switch (state) {
    case 'PENDING_CONFIRMATION':
      return [
        // Accepting commits the bakery, so it appears only once paid.
        ...(paymentState === 'PAID' ? [{ step: 'accept', label: 'پذیرش سفارش' }] : []),
        { step: 'reject', label: 'رد سفارش' },
      ]
    case 'CONFIRMED':
      return [
        { step: 'start-fulfillment', label: 'شروع تحویل' },
        // Cancelling after acceptance means giving the money back, so it is a
        // different act from rejecting an order nobody has paid for.
        { step: 'cancel', label: 'لغو و بازگشت وجه' },
      ]
    case 'IN_FULFILLMENT':
      return [{ step: 'complete', label: 'تکمیل سفارش' }]
    default:
      return []
  }
}

/** Production steps reachable from the current one, in the domain's order. */
export function availableProductionSteps(current: string): readonly string[] {
  const next: Readonly<Record<string, readonly string[]>> = {
    NOT_REQUIRED: [],
    UNSCHEDULED: ['SCHEDULED', 'IN_PRODUCTION'],
    SCHEDULED: ['IN_PRODUCTION', 'UNSCHEDULED'],
    IN_PRODUCTION: ['READY'],
    READY: ['HANDED_OFF'],
    HANDED_OFF: [],
  }
  return next[current] ?? []
}
