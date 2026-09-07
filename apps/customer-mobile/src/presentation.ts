import type { ProductSummary } from '@alo-noon/contracts'
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
