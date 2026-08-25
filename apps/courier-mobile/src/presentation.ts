import type { CourierReport } from './api'

/**
 * What the courier is looking at, and the one thing they should do about it.
 *
 * The person reading this screen is on a motorbike in the sun holding the phone
 * in one hand. So each order shows a single obvious action rather than a menu:
 * the delivery has exactly one forward step from wherever it is, and offering
 * four buttons would make them read instead of tap.
 *
 * The steps mirror the domain's transition table. They are restated here rather
 * than imported because this answers a different question — not "is this step
 * legal" but "what should the button say" — and the test below pins every state
 * the API can return so the two cannot silently diverge.
 */
export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  UNASSIGNED: 'در صف اعزام',
  ASSIGNMENT_PENDING: 'پیشنهاد تازه',
  ASSIGNED: 'پذیرفته‌اید — هنوز تحویل نگرفته‌اید',
  PICKED_UP: 'بار را گرفته‌اید',
  OUT_FOR_DELIVERY: 'در راه مشتری',
  DELIVERED: 'تحویل شد',
  FAILED: 'تحویل نشد',
  CANCELLED: 'لغو شد',
}

export interface CourierStep {
  /** The one action to put in front of the courier, if there is one. */
  readonly primary: { readonly to: CourierReport; readonly label: string } | null
  /** An outstanding offer, which is answered rather than advanced. */
  readonly isOffer: boolean
  /** Whether reporting a failure is available from here. */
  readonly canFail: boolean
}

const NOTHING: CourierStep = { primary: null, isOffer: false, canFail: false }

export function courierStepFor(state: string): CourierStep {
  switch (state) {
    case 'ASSIGNMENT_PENDING':
      // Answered, not advanced: the two answers lead to different places and
      // one of them gives the order back.
      return { primary: null, isOffer: true, canFail: false }
    case 'ASSIGNED':
      return {
        primary: { to: 'PICKED_UP', label: 'بار را تحویل گرفتم' },
        isOffer: false,
        canFail: false,
      }
    case 'PICKED_UP':
      // Failing is possible from here too — a courier who collects the bread and
      // then cannot deliver it has to be able to say so without pretending to
      // have set off first.
      return {
        primary: { to: 'OUT_FOR_DELIVERY', label: 'راه افتادم' },
        isOffer: false,
        canFail: true,
      }
    case 'OUT_FOR_DELIVERY':
      return {
        primary: { to: 'DELIVERED', label: 'تحویل دادم' },
        isOffer: false,
        canFail: true,
      }
    default:
      return NOTHING
  }
}

/**
 * Why a delivery did not happen.
 *
 * A fixed list rather than a text box: the API refuses a failure with no reason,
 * and nobody types a sentence one-handed at a stranger's door. These are the
 * five things that actually happen, and each one leads a dispatcher somewhere
 * different — call the customer, fix the address, or refund.
 */
export const FAILURE_REASONS: ReadonlyArray<{ readonly code: string; readonly label: string }> =
  Object.freeze([
    { code: 'NOBODY_HOME', label: 'کسی در محل نبود' },
    { code: 'WRONG_ADDRESS', label: 'نشانی درست نبود' },
    { code: 'CUSTOMER_REFUSED', label: 'مشتری تحویل نگرفت' },
    { code: 'INACCESSIBLE', label: 'دسترسی به محل ممکن نبود' },
    { code: 'OTHER', label: 'دلیل دیگر' },
  ])

export function formatRials(amount: string): string {
  if (!/^\d+$/.test(amount)) return amount
  return `${new Intl.NumberFormat('fa-IR').format(BigInt(amount))} ریال`
}

/**
 * The time a delivery is promised for, in the courier's own clock.
 *
 * Only the time of day: a courier deciding what to do next needs "۱۸:۳۰", not a
 * date they already know is today.
 */
export function formatDeadline(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat('fa-IR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tehran',
  }).format(parsed)
}

/**
 * A `tel:` target for the recipient's number.
 *
 * Returns null rather than a broken link when the number is not dialable, so a
 * courier never taps a call button that silently does nothing.
 */
export function telHref(mobileE164: string): string | null {
  return /^\+\d{8,15}$/.test(mobileE164) ? `tel:${mobileE164}` : null
}

/**
 * What went wrong, in words a courier can act on.
 *
 * `NOT_A_COURIER` is the one that matters most: it means the sign-in worked and
 * this simply is not their app, which is a different problem from a wrong code
 * and needs a different sentence.
 */
export function courierErrorMessage(code: string): string {
  switch (code) {
    case 'NOT_A_COURIER':
      return 'این شماره در فهرست پیک‌ها نیست. از دفتر بخواهید شما را ثبت کند.'
    case 'SESSION_UNAUTHORIZED':
      return 'نشست شما تمام شده. دوباره وارد شوید.'
    case 'DELIVERY_NOT_YOURS':
      return 'این سفارش دیگر دست شما نیست. فهرست را تازه کنید.'
    case 'OFFER_NOT_OPEN':
      return 'این پیشنهاد دیگر باز نیست. شاید به کس دیگری داده شده.'
    case 'DELIVERY_STEP_NOT_ALLOWED':
      return 'این مرحله از وضعیت فعلی سفارش ممکن نیست. فهرست را تازه کنید.'
    case 'DELIVERY_WRITE_CONFLICT':
      return 'هم‌زمان کس دیگری این سفارش را جابه‌جا کرد. دوباره تلاش کنید.'
    case 'FAILURE_REASON_REQUIRED':
      return 'برای ثبت عدم تحویل باید دلیلش را انتخاب کنید.'
    case 'AUTH_OTP_INVALID':
    case 'AUTH_OTP_EXPIRED':
      return 'کد وارد شده درست نیست یا منقضی شده.'
    case 'SERVICE_UNAVAILABLE':
    case 'DELIVERY_UNAVAILABLE':
      return 'ارتباط با سرور برقرار نشد. کمی بعد دوباره تلاش کنید.'
    default:
      return `درخواست انجام نشد (${code}).`
  }
}
