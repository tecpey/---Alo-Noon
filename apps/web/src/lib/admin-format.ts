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
  INVALID_OTP_REQUEST: 'شمارهٔ موبایل معتبر نیست.',
  INVALID_PROVIDER_CREDENTIAL_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_CONFIGURATION_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_GOVERNANCE_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_SMS_PROVIDER_COMMAND: 'مقادیر فرم معتبر نیست.',
  INVALID_SMS_PROVIDER_HEALTH_COMMAND: 'مقادیر فرم معتبر نیست.',
  RATE_LIMIT_EXCEEDED: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.',
  PROVIDER_GOVERNANCE_UNAVAILABLE: 'سرویس مدیریت موقتاً در دسترس نیست.',
}

/**
 * An unmapped code still reaches the operator verbatim. It is not secret, and
 * during provisioning it is often the only thing that says which invariant was
 * violated — swallowing it would leave them with nothing to act on.
 */
export function translateProviderError(code: string, fallback: string): string {
  return PROVIDER_ERROR_MESSAGES[code] ?? `${fallback} (${code})`
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

/**
 * Picks the session token out of the API's Set-Cookie headers.
 *
 * The API issues a session only as a cookie — the response body never carries
 * the token — so signing in means reading it here and re-setting it on this
 * origin. Only the session cookie is relayed: any other cookie the API sets is
 * left alone rather than blindly copied onto the panel's domain.
 */
export function sessionTokenFromSetCookie(
  setCookies: readonly string[],
  cookieName: string,
): string | null {
  for (const entry of setCookies) {
    const [pair] = entry.split(';')
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() !== cookieName) continue
    const value = pair.slice(separator + 1).trim()
    // A clearing cookie (`name=; Max-Age=0`) is not a session.
    if (value) return value
  }
  return null
}
