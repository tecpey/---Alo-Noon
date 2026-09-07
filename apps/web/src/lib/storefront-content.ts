import { appMeta } from '@alo-noon/config'

/**
 * The storefront's copy — everything on the page that is not bread.
 *
 * The bread itself is gone from here. Products, prices and categories come from
 * the catalog API, scoped to the customer's city, because a page that keeps its
 * own list of what is for sale is a page that will eventually disagree with the
 * shop about a price. What is left is the writing: the headline, the promises,
 * and the description of how ordering works, none of which is data.
 */

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

/**
 * The values here describe how ordering works. They are not this visitor's
 * state, and they must not read as though they were: the panel used to announce
 * a delivery window of «امروز، ۱۸:۰۰ – ۱۹:۰۰» to somebody who had not chosen
 * one, which is a promise the shop had not made and could not keep.
 *
 * The address value is a fallback only. When the storefront knows which city it
 * priced the shelves in, the page shows that instead.
 */
export const orderConditions: readonly OrderCondition[] = [
  { id: 'address', labelFa: 'آدرس تحویل', valueFa: 'شهرتان را انتخاب کنید', icon: 'pin' },
  { id: 'method', labelFa: 'نوع خرید', valueFa: 'تحویل درب منزل', icon: 'bag' },
  { id: 'window', labelFa: 'زمان تحویل', valueFa: 'هنگام تسویه انتخاب می‌کنید', icon: 'clock' },
]

/**
 * What the footer says about the shop.
 *
 * It used to read «زیرساخت سفارش نان آماده است» — a sentence written for whoever
 * was building the platform, on the page where a customer decides whether to
 * trust it with a card. This one says the thing a customer is actually asking:
 * who bakes the bread and when the money moves.
 */
export const foundationStatus = 'نان از نانوایی‌های محله؛ پرداخت امن، پیش از تأیید سفارش'

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
