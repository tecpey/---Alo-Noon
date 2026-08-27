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
  /** Which chip on the rail shows this bread. Matches an id in `categories`. */
  readonly categoryId: string
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
      categoryId: 'sweet',
      nameFa: 'کماج گردویی',
      priceRial: '280000',
      imageUrl: '/products/komaj-gerdooyi.jpg',
      imageAlt: 'کماج گردویی با روکش کنجد',
    },
    {
      slug: 'sangak-konjedi',
      categoryId: 'special',
      nameFa: 'نان سنگک کنجدی',
      priceRial: '95000',
      imageUrl: '/products/sangak-konjedi.jpg',
      imageAlt: 'نان سنگک تازه با کنجد',
    },
    {
      slug: 'barbari-konjedi',
      categoryId: 'special',
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
      categoryId: 'lavash',
      nameFa: 'لواش',
      priceRial: '50000',
      imageUrl: '/products/lavash-packaged.jpg',
      imageAlt: 'نان لواش در بسته‌بندی بهداشتی',
    },
    {
      slug: 'taftoon',
      categoryId: 'taftoon',
      nameFa: 'نان تافتون',
      priceRial: '60000',
      imageUrl: '/products/taftoon-packaged.jpg',
      imageAlt: 'نان تافتون در بسته‌بندی بهداشتی',
    },
    {
      slug: 'sangak',
      categoryId: 'sangak',
      nameFa: 'نان سنگک',
      priceRial: '65000',
      imageUrl: '/products/sangak-packaged.jpg',
      imageAlt: 'نان سنگک در بسته‌بندی بهداشتی',
    },
    {
      slug: 'barbari',
      categoryId: 'barbari',
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

/**
 * Why a customer should believe this shop, said in four short claims.
 *
 * Every one of them is something the system actually does — a delivery window
 * the customer picks, bread from a bakery that can reach their address, a
 * payment settled on the gateway's own answer, a fare measured on the road.
 * A trust strip listing promises the software cannot keep is worse than no
 * trust strip: it is the first thing a customer remembers when one breaks.
 */
export interface TrustClaim {
  readonly id: string
  readonly titleFa: string
  readonly bodyFa: string
  readonly icon: 'clock' | 'oven' | 'shield' | 'courier'
}

export const trustClaims: readonly TrustClaim[] = [
  {
    id: 'window',
    titleFa: 'بازهٔ تحویل را خودتان انتخاب می‌کنید',
    bodyFa: 'سفارش برای همان بازه برنامه‌ریزی می‌شود، نه «هر وقت شد».',
    icon: 'clock',
  },
  {
    id: 'fresh',
    titleFa: 'از تنور نانوایی محله',
    bodyFa: 'نانوایی‌هایی که واقعاً به نشانی شما می‌رسند، نه یک انبار مرکزی.',
    icon: 'oven',
  },
  {
    id: 'payment',
    titleFa: 'پرداخت امن و قابل پیگیری',
    bodyFa: 'تأیید نهایی با پاسخ خودِ درگاه انجام می‌شود، نه با بازگشت مرورگر.',
    icon: 'shield',
  },
  {
    id: 'delivery',
    titleFa: 'کرایه بر اساس مسیر واقعی',
    bodyFa: 'فاصله روی راه اندازه‌گیری می‌شود؛ خط مستقیم روی نقشه ملاک نیست.',
    icon: 'courier',
  },
]

/**
 * The bread categories, as a customer would name them.
 *
 * "همه" is first and selected, because a shop that opens filtered is a shop
 * hiding most of itself. The rest match the shelves below, so a chip and a
 * section are never two different ideas of the same thing.
 */
export interface Category {
  readonly id: string
  readonly labelFa: string
}

export const categories: readonly Category[] = [
  { id: 'all', labelFa: 'همه' },
  { id: 'special', labelFa: 'پخت ویژه' },
  { id: 'barbari', labelFa: 'بربری' },
  { id: 'sangak', labelFa: 'سنگک' },
  { id: 'lavash', labelFa: 'لواش' },
  { id: 'taftoon', labelFa: 'تافتون' },
  { id: 'sweet', labelFa: 'شیرینی و کماج' },
]

/**
 * Three steps, because that is how many there are.
 *
 * Written as what the customer does rather than what the system does. "ثبت
 * سفارش" is a database event; "نان و زمانش را انتخاب کنید" is the thing a
 * person actually performs.
 */
export interface OrderStep {
  readonly id: string
  readonly titleFa: string
  readonly bodyFa: string
}

export const orderSteps: readonly OrderStep[] = [
  {
    id: 'where',
    titleFa: 'نشانی‌تان را بگویید',
    bodyFa: 'نانوایی‌هایی که به محلهٔ شما می‌رسند مشخص می‌شوند.',
  },
  {
    id: 'what',
    titleFa: 'نان و زمانش را انتخاب کنید',
    bodyFa: 'پخت ویژه برای همان بازه، یا نان روزمرهٔ بسته‌بندی‌شده.',
  },
  {
    id: 'when',
    titleFa: 'درب منزل تحویل بگیرید',
    bodyFa: 'وضعیت سفارش تا لحظهٔ تحویل قابل پیگیری است.',
  },
]

/** Every bread on the page, by slug, for the basket to price its lines from. */
export const productsBySlug: ReadonlyMap<string, StorefrontProduct> = new Map(
  [...specialBakes.products, ...everydayBreads.products].map((product) => [product.slug, product]),
)
