import type { DeliveryEstimate, ProductSummary } from '@alo-noon/contracts'
import { formatTomanExact, parseIranianMobile, parseOtpCode } from '@alo-noon/domain'

// The keyboard-facing normalisers live in the domain package because the
// courier app takes the same two inputs from the same keyboards. Re-exported
// under the names this app already uses rather than renamed at every call site.
export const normalizeIranianMobile = parseIranianMobile
export const normalizeOtpCode = parseOtpCode

/**
 * A price, in the unit customers speak.
 *
 * Toman, like every price on the website. It used to be Rial here and Toman
 * there, which meant the same loaf read as ten times dearer in the app than on
 * the site — the kind of difference somebody notices once, mistrusts, and does
 * not come back from.
 *
 * The arithmetic lives in the domain so a message the API texts and a label the
 * app draws cannot disagree.
 *
 * The exact conversion, remainder and all. This screen shows wallet balances
 * and statement lines as well as prices, and a balance is whatever arithmetic
 * left behind — a refund, a reversal, a share of something. The strict
 * conversion refuses a half Toman, and the fallback here would then print the
 * raw Rial figure, unlabelled: a customer reading their own balance would see
 * ۸۳۲۵ where the truth is ۸۳۲٫۵. Ten times wrong, on their own money, is the
 * exact mistake this whole unit conversion exists to prevent.
 */
export function formatMoney(amount: string): string {
  if (!/^\d+$/.test(amount)) return amount
  try {
    return formatTomanExact(BigInt(amount))
  } catch {
    return amount
  }
}

export function productPromiseLabel(
  product: Pick<ProductSummary, 'freshnessClaim' | 'fulfillmentClass'>,
): string {
  if (
    product.fulfillmentClass === 'SIGNATURE_FRESH' &&
    product.freshnessClaim === 'FRESHLY_PRODUCED'
  ) {
    return 'تولید تازه ویژه'
  }

  switch (product.fulfillmentClass) {
    case 'PACKAGED_TRADITIONAL':
      return 'نان سنتی بسته‌بندی'
    case 'PACKAGED_FANTASY':
      return 'نان فانتزی بسته‌بندی'
    case 'PACKAGED_DIETARY':
      return 'نان رژیمی بسته‌بندی'
    case 'LIMITED_EDITION':
      return product.freshnessClaim === 'PACKAGED' ? 'نسخه محدود بسته‌بندی' : 'نسخه محدود'
    case 'SIGNATURE_FRESH':
      return 'محصول ویژه'
  }
}

export function serviceabilityMessage(
  reason: 'OUTSIDE_CITY' | 'OUTSIDE_SERVICE_AREA' | 'ZONE_SUSPENDED' | undefined,
): string {
  switch (reason) {
    case 'OUTSIDE_CITY':
      return 'این شهر هنوز در محدوده فعال الو نون نیست.'
    case 'ZONE_SUSPENDED':
      return 'ارسال در این محدوده موقتاً متوقف شده است.'
    case 'OUTSIDE_SERVICE_AREA':
    default:
      return 'نشانی فعلی خارج از محدوده ارسال است.'
  }
}

/**
 * The delivery fare, in the words the shop is allowed to use for it.
 *
 * The same three sentences the website prints, because a customer who checks
 * the price on their phone and then on the site must not meet two different
 * promises about one number. The web copy lives in `apps/web/src/lib/fare-line`
 * and this is its twin; the shared half is the contract's `basis`, which is
 * what actually decides the claim.
 *
 * Extra costs met late are the largest fixable cause of an abandoned basket
 * Baymard measures — 39% of shoppers — and until now this app said nothing
 * about the fare until after sign-in, an address and a delivery window.
 */
export interface FareLine {
  text: string
  note: string | null
  freeOver: string | null
}

export function fareLine(estimate: DeliveryEstimate | null | undefined): FareLine | null {
  if (!estimate) return null

  const amount = formatMoney(estimate.amount.amount)
  const freeOver =
    estimate.freeOver === null
      ? null
      : `سفارش بالای ${formatMoney(estimate.freeOver.amount)}: ارسال رایگان`

  switch (estimate.basis) {
    case 'EXACT':
      // One flat tariff and no provider to consult, so nothing left can move
      // it. This is a price and may read as one.
      return { text: `کرایهٔ پیک ${amount}`, note: 'برای این محدوده ثابت است', freeOver }
    case 'FROM':
      // Both reasons, because `FROM` is produced by a distance-banded tariff,
      // by a choice of vehicle, or by both.
      return {
        text: `کرایهٔ پیک از ${amount}`,
        note: 'بسته به مسافت و وسیله‌ای که انتخاب می‌کنید',
        freeOver,
      }
    case 'INDICATIVE':
      // A provider quotes at checkout and its answer wins — the way the fare is
      // worked out inside Tapsi's and Snapp's own applications.
      return {
        text: `کرایهٔ پیک حدود ${amount}`,
        note: 'مبلغ دقیق هنگام ثبت سفارش از سرویس تحویل گرفته می‌شود',
        freeOver,
      }
  }
}
