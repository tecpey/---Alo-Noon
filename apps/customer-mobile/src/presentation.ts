import type { ProductSummary } from '@alo-noon/contracts'

const persianDigits = '۰۱۲۳۴۵۶۷۸۹'
const arabicDigits = '٠١٢٣٤٥٦٧٨٩'

function normalizeDigits(value: string): string {
  return [...value]
    .map((character) => {
      const persianIndex = persianDigits.indexOf(character)
      if (persianIndex >= 0) return String(persianIndex)
      const arabicIndex = arabicDigits.indexOf(character)
      return arabicIndex >= 0 ? String(arabicIndex) : character
    })
    .join('')
}

export function normalizeIranianMobile(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/[\s()-]/g, '')

  if (/^09\d{9}$/.test(ascii)) return `+98${ascii.slice(1)}`
  if (/^9\d{9}$/.test(ascii)) return `+98${ascii}`
  if (/^\+989\d{9}$/.test(ascii)) return ascii
  if (/^00989\d{9}$/.test(ascii)) return `+${ascii.slice(2)}`
  return null
}

export function normalizeOtpCode(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/\s/g, '')
  return /^\d{6}$/.test(ascii) ? ascii : null
}

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
