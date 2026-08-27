import { appMeta } from '@alo-noon/config'

/**
 * What the storefront shows before a customer has told it anything.
 *
 * Deliberately typed as the shape the catalog API already returns rather than
 * as loose page copy: when the public catalog endpoint is wired to this page,
 * the change is a data source swap, not a rewrite of the markup. Until then
 * these are the launch products, priced in Rial like everything else in the
 * system so nothing here has its own idea of money.
 *
 * The photographs are the ones from the brand's own design board. They are
 * placeholders in the honest sense: correct products, correct crop, but shot
 * for a mock-up rather than for a shop. Real photography replaces the files in
 * `public/products/` without touching this file.
 */

export interface StorefrontProduct {
  readonly slug: string
  readonly nameFa: string
  /** Rial, as a decimal string, exactly as the ledger holds it. */
  readonly priceRial: string
  readonly imageUrl: string
  /** Alternative text; describes the bread, not the photograph. */
  readonly imageAlt: string
}

export interface StorefrontSection {
  readonly id: string
  readonly titleFa: string
  readonly noteFa: string
  readonly products: readonly StorefrontProduct[]
}

export const specialBakes: StorefrontSection = {
  id: 'special',
  titleFa: 'پخت‌های ویژه',
  noteFa: 'به صورت تازه و داغ',
  products: [
    {
      slug: 'komaj-gerdooyi',
      nameFa: 'کماج گردویی',
      priceRial: '280000',
      imageUrl: '/products/komaj-gerdooyi.jpg',
      imageAlt: 'کماج گردویی با روکش کنجد',
    },
    {
      slug: 'sangak-konjedi',
      nameFa: 'نان سنگک کنجدی',
      priceRial: '95000',
      imageUrl: '/products/sangak-konjedi.jpg',
      imageAlt: 'نان سنگک تازه با کنجد',
    },
    {
      slug: 'barbari-konjedi',
      nameFa: 'نان بربری کنجدی',
      priceRial: '70000',
      imageUrl: '/products/barbari-konjedi.jpg',
      imageAlt: 'نان بربری کنجدی تازه از تنور',
    },
  ],
}

export const everydayBreads: StorefrontSection = {
  id: 'everyday',
  titleFa: 'نان روزمره بسته‌بندی‌شده',
  noteFa: 'بسته‌بندی بهداشتی',
  products: [
    {
      slug: 'lavash',
      nameFa: 'لواش',
      priceRial: '50000',
      imageUrl: '/products/lavash-packaged.jpg',
      imageAlt: 'نان لواش در بسته‌بندی بهداشتی',
    },
    {
      slug: 'taftoon',
      nameFa: 'نان تافتون',
      priceRial: '60000',
      imageUrl: '/products/taftoon-packaged.jpg',
      imageAlt: 'نان تافتون در بسته‌بندی بهداشتی',
    },
    {
      slug: 'sangak',
      nameFa: 'نان سنگک',
      priceRial: '65000',
      imageUrl: '/products/sangak-packaged.jpg',
      imageAlt: 'نان سنگک در بسته‌بندی بهداشتی',
    },
    {
      slug: 'barbari',
      nameFa: 'نان بربری',
      priceRial: '60000',
      imageUrl: '/products/barbari-packaged.jpg',
      imageAlt: 'نان بربری در بسته‌بندی بهداشتی',
    },
  ],
}

/**
 * The three things a bread order actually depends on, answered before anything
 * is added to a basket.
 *
 * They sit together under the headline because they are one decision: where,
 * how, and when. Asking them at checkout instead is how a customer fills a
 * basket from a bakery that cannot reach them.
 */
export interface OrderCondition {
  readonly id: string
  readonly labelFa: string
  readonly valueFa: string
  readonly icon: 'pin' | 'bag' | 'clock'
}

export const orderConditions: readonly OrderCondition[] = [
  { id: 'address', labelFa: 'آدرس تحویل', valueFa: 'بابل، محله مدرس', icon: 'pin' },
  { id: 'method', labelFa: 'نوع خرید', valueFa: 'تحویل درب منزل', icon: 'bag' },
  { id: 'window', labelFa: 'زمان تحویل', valueFa: 'امروز، ۱۸:۰۰ – ۱۹:۰۰', icon: 'clock' },
]

export const heroCopy = {
  /** Two lines, and they break where the artwork breaks them. */
  headlineFa: ['نانِ درست،', 'در زمانِ درست'],
  leadFa: 'پخت‌های ویژه، تازه و سفارشی؛ نان روزمره، بسته‌بندی‌شده و بهداشتی',
  ctaFa: 'شروع سفارش',
} as const

export const brandCopy = {
  nameFa: appMeta.nameFa,
  taglineFa: appMeta.taglineFa,
  searchPlaceholderFa: 'جست‌وجو در نان‌ها و محصولات...',
  accountFa: 'حساب کاربری',
  basketFa: 'سبد خرید',
} as const
