import type { ProductSummary } from '@alo-noon/contracts'
import { parseIranianMobile, parseOtpCode } from '@alo-noon/domain'

// The keyboard-facing normalisers live in the domain package because the
// courier app takes the same two inputs from the same keyboards. Re-exported
// under the names this app already uses rather than renamed at every call site.
export const normalizeIranianMobile = parseIranianMobile
export const normalizeOtpCode = parseOtpCode

export function formatRials(amount: string): string {
  if (!/^\d+$/.test(amount)) return amount
  return `${new Intl.NumberFormat('fa-IR').format(BigInt(amount))} ریال`
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
