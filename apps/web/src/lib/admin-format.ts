import { promotionRefusalMessage } from '@alo-noon/domain'

export { sessionTokenFromSetCookie } from './api-envelope'

/**
 * Pure helpers behind the admin panel's Server Actions.
 *
 * They live outside `admin-actions.ts` because a `'use server'` module may only
 * export async functions, which also means nothing in there can be unit tested
 * directly. The parts worth testing — picking the right cookie out of a
 * Set-Cookie list, and deriving a stable idempotency key — are here.
 */

/** Persian text for the API's error codes; anything unmapped keeps its code. */
export const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // The cash desk. Each of these sends the operator somewhere different —
  // recount, pick a different set, chase a courier — which is the whole reason
  // they are separate codes rather than one refusal.
  REMITTANCE_DOES_NOT_BALANCE:
    'مبلغ شمرده‌شده با جمع سفارش‌های انتخاب‌شده نمی‌خواند. دوباره بشمارید یا سفارش‌های دیگری را انتخاب کنید. تا وقتی نخواند هیچ ثبتی انجام نمی‌شود.',
  REMITTANCE_COURIER_MISMATCH: 'یکی از این سفارش‌ها را پیک دیگری برده است.',
  REMITTANCE_ORDER_NOT_COLLECTIBLE:
    'یکی از این سفارش‌ها سفارش نقدیِ وصول‌شده نیست، یا پولش قبلاً تحویل گرفته شده.',
  REMITTANCE_EMPTY: 'هیچ سفارشی برای تسویه انتخاب نشده است.',
  CASH_PAYMENT_MISSING: 'برای این سفارش پرداختی ثبت نشده که وجهش وصول شود.',
  CASH_CONCURRENCY_CONFLICT: 'همزمان کس دیگری در حال شمردن بود. دوباره تلاش کنید.',
  LEDGER_ACCOUNT_NOT_FOUND: 'حساب‌های صندوق برای این مجموعه ساخته نشده است.',
  API_UNREACHABLE: 'ارتباط با سرویس برقرار نشد.',
  SESSION_UNAUTHORIZED: 'نشست معتبر نیست. دوباره وارد شوید.',
  ADMIN_PERMISSION_DENIED: 'این حساب دسترسی لازم برای این کار را ندارد.',
  PAYMENT_PROVIDER_OPERATION_FORBIDDEN: 'دسترسی این حساب لغو شده است.',
  AUTH_DELIVERY_PROVIDER_OPERATION_FORBIDDEN: 'دسترسی این حساب لغو شده است.',
  PROVIDER_CONFIGURATION_NOT_FOUND: 'این پیکربندی یافت نشد.',
  AUTH_DELIVERY_CONFIGURATION_NOT_FOUND: 'این پیکربندی یافت نشد.',
  IDEMPOTENCY_KEY_CONFLICT: 'این کلید قبلاً با درخواستی متفاوت استفاده شده است.',
  PROVIDER_DEFAULT_CONFLICT: 'یک درگاه پیش‌فرض دیگر در همین محیط فعال است.',
  PROVIDER_CONFIGURATION_STATE_UNCHANGED: 'وضعیت این پیکربندی تغییری نکرد.',
  PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE: 'برای این درگاه و این نسخه، آداپتوری وجود ندارد.',
  INVALID_PROVIDER_CREDENTIAL_REFERENCE: 'ارجاع کلید معتبر نیست.',
  AUTH_DELIVERY_DEFAULT_ALREADY_EXISTS: 'یک سرویس پیامک پیش‌فرض فعال از قبل وجود دارد.',
  AUTH_DELIVERY_CONFIGURATION_CONFLICT: 'پیکربندی موجود با این مقادیر همخوانی ندارد.',
  AUTH_DELIVERY_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE:
    'ارجاع env:// باید با AUTH_SMS_ شروع شود تا در زمان ارسال قابل تشخیص باشد.',
  AUTH_DELIVERY_DEFAULT_MUST_BE_ENABLED: 'سرویس پیش‌فرض باید فعال باشد.',
  EMAIL_PROVIDER_OPERATION_FORBIDDEN: 'این حساب اجازهٔ مدیریت سرویس ایمیل را ندارد.',
  EMAIL_CONFIGURATION_NOT_FOUND: 'چنین سرویس ایمیلی برای این مستأجر ثبت نشده است.',
  EMAIL_DEFAULT_ALREADY_EXISTS:
    'برای این محیط از قبل یک سرویس ایمیل پیش‌فرض وجود دارد. اول آن را از چرخه خارج کنید.',
  EMAIL_CONFIGURATION_CONFLICT: 'سرویسی با همین کد و نسخه هست ولی مقادیرش فرق دارد.',
  EMAIL_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE:
    'ارجاع env:// باید با EMAIL_ شروع شود، وگرنه هنگام ارسال هیچ رمزی پیدا نمی‌شود.',
  EMAIL_CREDENTIAL_REFERENCE_INVALID:
    'ارجاع رمز معتبر نیست. باید مثل env://EMAIL_SMTP_PASSWORD باشد.',
  EMAIL_SENDER_ADDRESS_INVALID: 'نشانی فرستنده معتبر نیست.',
  EMAIL_SENDER_NAME_INVALID: 'نام فرستنده را بنویسید؛ همان چیزی است که گیرنده می‌بیند.',
  EMAIL_DEFAULT_MUST_BE_ENABLED: 'سرویس ایمیل پیش‌فرض باید فعال باشد.',
  EMAIL_PROVIDER_CODE_INVALID: 'کد سرویس باید با حروف بزرگ لاتین باشد، مثل SMTP.',
  EMAIL_ADAPTER_VERSION_INVALID: 'نسخهٔ آداپتور باید به شکل ۱.۰.۰ باشد.',
  EMAIL_PRIORITY_OUT_OF_RANGE: 'اولویت باید عددی بین ۱ تا ۱۰۰۰ باشد.',
  EMAIL_REASON_REQUIRED: 'دلیل را بنویسید؛ در تاریخچهٔ ممیزی ثبت می‌شود.',
  EMAIL_RECIPIENT_ADDRESS_INVALID: 'نشانی گیرنده معتبر نیست.',
  EMAIL_RECIPIENT_NAME_INVALID: 'نام گیرنده را بنویسید.',
  EMAIL_RECIPIENT_ALREADY_EXISTS:
    'این نشانی از قبل در فهرست است. بزرگی و کوچکی حروف فرقی نمی‌کند — یک صندوق است.',
  EMAIL_RECIPIENT_NOT_FOUND: 'چنین گیرنده‌ای ثبت نشده است.',
  INVALID_ALERT_RECIPIENT_COMMAND:
    'مقادیر فرم معتبر نیست. معمولاً نشانی است — باید مثل ops@example.com باشد، بدون فاصله.',
  ROUTING_PROVIDER_OPERATION_FORBIDDEN: 'این حساب اجازهٔ مدیریت مسیریاب را ندارد.',
  ROUTING_CONFIGURATION_NOT_FOUND: 'چنین مسیریابی برای این مستأجر ثبت نشده است.',
  ROUTING_DEFAULT_ALREADY_EXISTS:
    'برای این محیط از قبل یک مسیریاب پیش‌فرض وجود دارد. اول آن را از چرخه خارج کنید.',
  ROUTING_CONFIGURATION_CONFLICT: 'مسیریابی با همین کد و نسخه هست ولی مقادیرش فرق دارد.',
  ROUTING_ENV_CREDENTIAL_REFERENCE_UNRESOLVABLE:
    'ارجاع env:// باید با ROUTING_ شروع شود، وگرنه هنگام محاسبهٔ فاصله هیچ کلیدی پیدا نمی‌شود.',
  ROUTING_CREDENTIAL_REFERENCE_INVALID:
    'ارجاع کلید معتبر نیست. باید مثل env://ROUTING_NESHAN_KEY باشد.',
  ROUTING_DEFAULT_MUST_BE_ENABLED: 'مسیریاب پیش‌فرض باید فعال باشد.',
  ROUTING_PROVIDER_CODE_INVALID: 'کد مسیریاب باید با حروف بزرگ لاتین باشد، مثل NESHAN.',
  ROUTING_ADAPTER_VERSION_INVALID: 'نسخهٔ آداپتور باید به شکل ۱.۰.۰ باشد.',
  ROUTING_PRIORITY_OUT_OF_RANGE: 'اولویت باید عددی بین ۱ تا ۱۰۰۰ باشد.',
  ROUTING_REASON_REQUIRED: 'دلیل را بنویسید؛ در تاریخچهٔ ممیزی ثبت می‌شود.',
  INVALID_OTP_REQUEST: 'شمارهٔ موبایل معتبر نیست.',
  INVALID_PROVIDER_CREDENTIAL_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_CONFIGURATION_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_GOVERNANCE_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_SMS_PROVIDER_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_SMS_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  // These name the likely field rather than stopping at «فرم معتبر نیست»: the
  // schema refuses before it can say which value was wrong, and the operator
  // is left staring at a form with eight inputs.
  INVALID_EMAIL_PROVIDER_COMMAND:
    'مقادیر فرم معتبر نیست. معمولاً نشانی فرستنده است — باید مثل no-reply@example.com باشد، بدون فاصله.',
  INVALID_EMAIL_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_ROUTING_PROVIDER_COMMAND:
    'مقادیر فرم معتبر نیست. معمولاً ارجاع کلید است — باید مثل env://ROUTING_NESHAN_KEY باشد.',
  INVALID_ROUTING_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  RATE_LIMIT_EXCEEDED: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.',
  PROVIDER_GOVERNANCE_UNAVAILABLE: 'سرویس مدیریت موقتاً در دسترس نیست.',
  CATALOG_OPERATION_FORBIDDEN: 'این حساب اجازهٔ مدیریت کاتالوگ را ندارد.',
  CATALOG_UNAVAILABLE: 'سرویس کاتالوگ موقتاً در دسترس نیست.',
  CATALOG_WRITE_CONFLICT: 'تغییر دیگری زودتر ثبت شد. صفحه را تازه کنید و دوباره تلاش کنید.',
  CATEGORY_CODE_TAKEN: 'این کد دسته قبلاً استفاده شده است.',
  CATEGORY_NOT_FOUND: 'این دسته یافت نشد.',
  PRODUCT_SLUG_TAKEN: 'این نشانی (slug) قبلاً استفاده شده است.',
  PRODUCT_NOT_FOUND: 'این محصول یافت نشد.',
  PRODUCT_RETIRED: 'محصول بازنشسته است و گونهٔ تازه نمی‌پذیرد.',
  PRODUCT_NOT_ACTIVE: 'اول خود محصول را فعال کنید.',
  VARIANT_SKU_TAKEN: 'این SKU قبلاً استفاده شده است.',
  VARIANT_NOT_FOUND: 'این گونه یافت نشد.',
  VARIANT_RETIRED: 'گونهٔ بازنشسته را نمی‌توان عرضه کرد.',
  VARIANT_NOT_ACTIVE: 'اول گونه را فعال کنید.',
  PRODUCT_CLASSIFICATION_INVALID: 'ترکیب طبقه‌بندی محصول معتبر نیست.',
  LIFECYCLE_TRANSITION_INVALID: 'این تغییر وضعیت مجاز نیست. «بازنشسته» بازگشت‌ناپذیر است.',
  OFFERINGS_STILL_LIVE: 'اول عرضه‌های فعال را متوقف کنید.',
  BRANCH_NOT_FOUND: 'این شعبه یافت نشد.',
  OFFERING_NOT_FOUND: 'این عرضه یافت نشد.',
  OFFERING_ALREADY_EXISTS: 'این شعبه همین گونه را از قبل عرضه می‌کند.',
  OFFERING_RETIRED: 'عرضهٔ بازنشسته قابل تغییر نیست.',
  OFFERING_STOCK_SHAPE_INVALID: 'تعداد موجود فقط وقتی معنا دارد که شمارش موجودی روشن باشد.',
  INVALID_CATEGORY_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PRODUCT_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_VARIANT_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_OFFERING_COMMAND: 'مقادیر فرم معتبر نیست.',
  ACCESS_OPERATION_FORBIDDEN: 'این حساب اجازهٔ مدیریت دسترسی‌ها را ندارد.',
  ACCESS_UNAVAILABLE: 'سرویس مدیریت دسترسی موقتاً در دسترس نیست.',
  ACCESS_WRITE_CONFLICT: 'تغییر دیگری زودتر ثبت شد. صفحه را تازه کنید.',
  ROLE_UNKNOWN: 'چنین نقشی وجود ندارد.',
  ROLE_EXCEEDS_GRANTER:
    'این نقش دسترسی‌ای دارد که حساب شما ندارد؛ نمی‌توانید آن را بدهید یا بگیرید.',
  ACCOUNT_NOT_FOUND: 'حسابی با این شماره نیست. اول یک بار با همان شماره وارد شوند.',
  ACCOUNT_NOT_ACTIVE: 'این حساب فعال نیست.',
  ACCOUNT_NOT_IN_TENANT: 'این حساب عضو این tenant نیست.',
  GRANT_NOT_FOUND: 'این دسترسی یافت نشد.',
  CANNOT_REVOKE_SELF: 'حساب نمی‌تواند دسترسی خودش را لغو کند.',
  INVALID_GRANT_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_REVOKE_COMMAND: 'مقادیر فرم معتبر نیست.',
  ORDER_OPERATION_FORBIDDEN: 'این حساب اجازهٔ اداره‌کردن سفارش‌ها را ندارد.',
  ORDER_OPERATIONS_UNAVAILABLE: 'سرویس سفارش‌ها موقتاً در دسترس نیست.',
  ORDER_NOT_FOUND: 'این سفارش یافت نشد.',
  ORDER_NOT_PAID: 'این سفارش هنوز پرداخت نشده است.',
  TRANSITION_NOT_ALLOWED: 'این مرحله از وضعیت فعلی سفارش در دسترس نیست.',
  TRANSITION_NOT_PERMITTED: 'کارکنان مجاز به این مرحله نیستند.',
  PRODUCTION_NOT_APPLICABLE: 'در این وضعیت سفارش، مرحلهٔ تولید معنا ندارد.',
  ORDER_WRITE_CONFLICT: 'کس دیگری زودتر این سفارش را جابه‌جا کرد. صفحه را تازه کنید.',
  INVALID_ORDER_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PRODUCTION_COMMAND: 'مقادیر فرم معتبر نیست.',
  REFUND_QUARANTINED:
    'بازگشت وجه رد شد و نیاز به بررسی انسان دارد. سفارش عمداً لغو نشد تا مشکل زیر یک سفارشِ ظاهراً تمام‌شده پنهان نماند.',
}

/**
 * An unmapped code still reaches the operator verbatim. It is not secret, and
 * during provisioning it is often the only thing that says which invariant was
 * violated — swallowing it would leave them with nothing to act on.
 *
 * Discount-code refusals are not in the table above. They are answered by the
 * domain, beside the codes themselves, because the phone shows the same
 * sentences and a copy here would eventually tell a customer on the site
 * something different about the same code.
 */
export function translateProviderError(code: string, fallback: string): string {
  return PROVIDER_ERROR_MESSAGES[code] ?? promotionRefusalMessage(code) ?? `${fallback} (${code})`
}

/**
 * Derives the idempotency key for a governance write from what makes the command
 * unique, so a double-submitted form replays onto the same record instead of
 * creating a second one. The operator should not have to invent one.
 *
 * The API requires 16–128 characters matching `[A-Za-z0-9._:-]`, so anything
 * outside that — Persian reason text, spaces, slashes in a reference — is
 * folded to a hyphen rather than rejected at the boundary.
 */
export function derivedIdempotencyKey(...parts: readonly string[]): string {
  return parts
    .join('-')
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 128)
    .padEnd(16, '0')
}
