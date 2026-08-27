'use server'

import { randomUUID } from 'node:crypto'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import type { ActionState } from './action-state'
import { authPost, sessionTokenFromSetCookie } from './api-core'
import { patch, post, put, revokeSession } from './admin-api'
import {
  derivedIdempotencyKey,
  PROVIDER_ERROR_MESSAGES,
  translateProviderError,
} from './admin-format'

/**
 * Server Actions behind the admin panel. Nothing here runs in the browser, so
 * the session token and every provider command stay server-side.
 *
 * Each action returns a message for the form to display rather than throwing:
 * an operator mid-provisioning needs to see which step failed and why, not a
 * generic error page that loses the rest of the form.
 */
const SESSION_COOKIE = 'alo_session'

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim()
}

function failure(message: string): ActionState {
  return { status: 'error', message }
}

function success(message: string): ActionState {
  return { status: 'ok', message }
}

export async function requestOtpAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const mobileE164 = field(form, 'mobileE164')
  const cookieStore = await cookies()

  // Sign-in cannot go through the shared client: it must read the API's raw
  // response headers to relay the session cookie, which the client abstracts
  // away, and OTP request needs its own Idempotency-Key.
  const response = await authPost('/api/v1/auth/otp/request', { mobileE164 }, randomUUID())
  if (!response) return failure(PROVIDER_ERROR_MESSAGES['API_UNREACHABLE']!)

  const payload = (await response.json().catch(() => null)) as {
    data?: { challengeId?: string }
    error?: { code?: string }
  } | null
  if (!response.ok || !payload?.data?.challengeId) {
    return failure(
      translateProviderError(payload?.error?.code ?? 'UNKNOWN', 'ارسال کد ناموفق بود.'),
    )
  }

  // The challenge id is not a secret and not a credential — it only names which
  // challenge the next step verifies — but it has no reason to reach the URL bar
  // or browser history, so it rides in a short-lived HttpOnly cookie.
  cookieStore.set('alo_admin_challenge', payload.data.challengeId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/admin',
    maxAge: 10 * 60,
  })
  return success('کد تأیید ارسال شد. اگر پیامکی نرسید، سرویس پیامک هنوز پیکربندی نشده است.')
}

export async function verifyOtpAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const cookieStore = await cookies()
  const challengeId = cookieStore.get('alo_admin_challenge')?.value
  if (!challengeId) return failure('ابتدا کد تأیید را درخواست کنید.')

  const response = await authPost('/api/v1/auth/otp/verify', {
    challengeId,
    code: field(form, 'code'),
  })
  if (!response) return failure(PROVIDER_ERROR_MESSAGES['API_UNREACHABLE']!)

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string }
    } | null
    return failure(
      translateProviderError(payload?.error?.code ?? 'UNKNOWN', 'کد تأیید پذیرفته نشد.'),
    )
  }

  // The API issues the session only as a Set-Cookie; the response body never
  // carries the token. Relay it to the browser rather than reading a token that
  // does not exist, and keep it HttpOnly on this origin too.
  const token = sessionTokenFromSetCookie(response.headers.getSetCookie(), SESSION_COOKIE)
  if (!token) return failure('نشست ایجاد نشد. دوباره تلاش کنید.')
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  cookieStore.delete('alo_admin_challenge')
  redirect('/admin')
}

export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies()
  // Revoke on the API first: dropping only the browser cookie would leave a
  // usable session alive for its full lifetime.
  await revokeSession()
  cookieStore.delete(SESSION_COOKIE)
  redirect('/admin/login')
}

export async function createPaymentCredentialAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const providerCode = field(form, 'providerCode').toUpperCase()
  const reference = field(form, 'reference')
  const result = await post<{ id: string }>('/api/v1/admin/payment-providers/credentials', {
    providerCode,
    reference,
    keyVersion: field(form, 'keyVersion') || 'v1',
    metadata: {},
    idempotencyKey: derivedIdempotencyKey('credential', providerCode, reference),
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'ثبت ارجاع کلید ناموفق بود.'))
  revalidatePath('/admin')
  return success(`ارجاع کلید ثبت شد. شناسه: ${result.data.id}`)
}

export async function createPaymentConfigurationAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const providerCode = field(form, 'providerCode').toUpperCase()
  const environment = field(form, 'environment')
  const credentialReferenceId = field(form, 'credentialReferenceId')
  const result = await post<{ id: string }>('/api/v1/admin/payment-providers/configurations', {
    providerCode,
    adapterVersion: field(form, 'adapterVersion') || '1.0.0',
    adapterSpiVersion: 1,
    merchantReference: field(form, 'merchantReference'),
    environment,
    paymentContext: 'CHECKOUT',
    currency: 'IRR',
    callbackPolicy: 'SIGNED_ONLY',
    // Both, always: a gateway that can start a payment but not verify it takes
    // money and never records it.
    capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
    credentialReferenceId,
    idempotencyKey: derivedIdempotencyKey(
      'configuration',
      providerCode,
      environment,
      credentialReferenceId,
    ),
    reason: field(form, 'reason'),
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'ایجاد پیکربندی ناموفق بود.'))
  revalidatePath('/admin')
  return success('پیکربندی ساخته شد. هنوز غیرفعال و با سلامت نامشخص است.')
}

export async function governPaymentConfigurationAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const configurationId = field(form, 'configurationId')
  const targetActive = field(form, 'targetActive') === 'true'
  const makeDefault = field(form, 'makeDefault') === 'true'
  const version = field(form, 'governanceVersion')
  const result = await post(
    `/api/v1/admin/payment-providers/configurations/${configurationId}/governance`,
    {
      targetActive,
      makeDefault,
      // The governance version is part of the key, so re-submitting the same
      // page replays, while a genuinely new decision gets a new key.
      idempotencyKey: derivedIdempotencyKey(
        'governance',
        configurationId,
        version,
        String(targetActive),
      ),
      reason: field(form, 'reason') || 'تغییر وضعیت از پنل مدیریت',
    },
  )
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت ناموفق بود.'))
  revalidatePath('/admin')
  return success(targetActive ? 'درگاه فعال شد.' : 'درگاه غیرفعال شد.')
}

export async function setPaymentHealthAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const configurationId = field(form, 'configurationId')
  const healthStatus = field(form, 'healthStatus')
  const result = await post(
    `/api/v1/admin/payment-providers/configurations/${configurationId}/health`,
    { healthStatus, reason: field(form, 'reason') || 'ثبت سلامت از پنل مدیریت' },
  )
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت سلامت ناموفق بود.'))
  revalidatePath('/admin')
  return success(
    healthStatus === 'HEALTHY'
      ? 'درگاه سالم علامت خورد و اکنون قابل انتخاب است.'
      : 'درگاه از چرخهٔ انتخاب خارج شد.',
  )
}

export async function createSmsConfigurationAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const priority = field(form, 'priority')
  const result = await post<{ id: string }>('/api/v1/admin/sms-providers/configurations', {
    providerCode: field(form, 'providerCode').toUpperCase(),
    adapterVersion: field(form, 'adapterVersion') || '1.0.0',
    environment: field(form, 'environment'),
    credentialReference: field(form, 'credentialReference'),
    senderReference: field(form, 'senderReference'),
    templateReference: field(form, 'templateReference'),
    enabled: field(form, 'enabled') === 'true',
    isDefault: field(form, 'isDefault') === 'true',
    ...(priority && { priority: Number(priority) }),
    reason: field(form, 'reason'),
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'ثبت سرویس پیامک ناموفق بود.'))
  revalidatePath('/admin')
  return success('سرویس پیامک ثبت شد. این پیکربندی تغییرناپذیر است؛ فقط سلامت آن قابل تغییر است.')
}

export async function setSmsHealthAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const configurationId = field(form, 'configurationId')
  const healthStatus = field(form, 'healthStatus')
  const result = await post(
    `/api/v1/admin/sms-providers/configurations/${configurationId}/health`,
    { healthStatus, reason: field(form, 'reason') || 'ثبت سلامت از پنل مدیریت' },
  )
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت سلامت ناموفق بود.'))
  revalidatePath('/admin')
  return success(
    healthStatus === 'HEALTHY' ? 'سرویس پیامک به چرخه بازگشت.' : 'سرویس پیامک از چرخه خارج شد.',
  )
}

/**
 * Unauthenticated POST to the API, returning the raw response so the caller can
 * read its headers. Null means the API could not be reached at all.
 */
// ---------------------------------------------------------------------------
// Catalogue and pricing
// ---------------------------------------------------------------------------

/**
 * A price typed into a form arrives with whatever separators the operator uses
 * — Persian digits, thousands commas, spaces. The API takes Rial as a plain
 * decimal string, so normalise here and refuse anything left over rather than
 * stripping characters until something parses.
 */
function priceField(form: FormData, name: string): string | null {
  const raw = field(form, name)
  if (!raw) return null
  const latin = raw
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[,٬\s]/g, '')
  return /^[1-9][0-9]{0,17}$/.test(latin) ? latin : null
}

function numberField(form: FormData, name: string): number | undefined {
  const raw = field(form, name)
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export async function createCatalogCategoryAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await post<{ id: string }>('/api/v1/admin/catalog/categories', {
    code: field(form, 'code').toUpperCase(),
    nameFa: field(form, 'nameFa'),
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت دسته ناموفق بود.'))
  revalidatePath('/admin/catalog')
  return success('دسته ساخته شد.')
}

export async function createProductAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const descriptionFa = field(form, 'descriptionFa')
  const result = await post<{ id: string }>('/api/v1/admin/catalog/products', {
    categoryId: field(form, 'categoryId'),
    slug: field(form, 'slug').toLowerCase(),
    nameFa: field(form, 'nameFa'),
    ...(descriptionFa && { descriptionFa }),
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت محصول ناموفق بود.'))
  revalidatePath('/admin/catalog')
  return success('محصول به صورت پیش‌نویس ساخته شد. برای فروش باید فعال شود.')
}

export async function createVariantAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const productId = field(form, 'productId')
  const fulfillmentClass = field(form, 'fulfillmentClass')
  // The two classification families need different windows, and sending the
  // wrong set is what the domain refuses. Pick by class rather than posting
  // every field and hoping.
  const fresh = fulfillmentClass === 'SIGNATURE_FRESH'
  const result = await post<{ id: string }>(
    `/api/v1/admin/catalog/products/${productId}/variants`,
    {
      sku: field(form, 'sku').toUpperCase(),
      nameFa: field(form, 'nameFa'),
      fulfillmentClass,
      freshnessClaim: fresh ? 'FRESHLY_PRODUCED' : 'PACKAGED',
      productionMode: fresh ? 'MADE_TO_ORDER' : 'READY_STOCK',
      fulfillmentControl: fresh ? 'CONTROLLED_PICKUP' : 'PLATFORM_STOCK',
      ...(fresh
        ? {
            productionWindowMinutes: numberField(form, 'productionWindowMinutes') ?? 30,
            pickupWithinMinutes: numberField(form, 'pickupWithinMinutes') ?? 15,
            freshnessWindowMinutes: numberField(form, 'freshnessWindowMinutes') ?? 90,
          }
        : {
            packagingType: 'MANUFACTURER_PACKAGED',
            shelfLifeMinutes: numberField(form, 'shelfLifeMinutes') ?? 10_080,
          }),
      ingredients: splitList(field(form, 'ingredients')),
      allergens: splitList(field(form, 'allergens')),
      dietaryAttributes: [],
    },
  )
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت گونه ناموفق بود.'))
  revalidatePath('/admin/catalog')
  return success('گونه به صورت پیش‌نویس ساخته شد.')
}

export async function setProductLifecycleAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const productId = field(form, 'productId')
  const lifecycle = field(form, 'lifecycle')
  const result = await patch(`/api/v1/admin/catalog/products/${productId}`, {
    lifecycle,
    reason: field(form, 'reason') || 'تغییر وضعیت از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت محصول ناموفق بود.'))
  revalidatePath('/admin/catalog')
  return success(lifecycle === 'ACTIVE' ? 'محصول فعال شد.' : 'وضعیت محصول تغییر کرد.')
}

export async function setVariantLifecycleAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const variantId = field(form, 'variantId')
  const lifecycle = field(form, 'lifecycle')
  const result = await patch(`/api/v1/admin/catalog/variants/${variantId}`, {
    lifecycle,
    reason: field(form, 'reason') || 'تغییر وضعیت از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت گونه ناموفق بود.'))
  revalidatePath('/admin/catalog')
  return success(lifecycle === 'ACTIVE' ? 'گونه فعال شد.' : 'وضعیت گونه تغییر کرد.')
}

export async function createOfferingAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const price = priceField(form, 'price')
  if (!price) return failure('قیمت باید عددی مثبت به ریال باشد.')
  const stockOnHand = numberField(form, 'stockOnHand')
  const dailyCapacity = numberField(form, 'dailyCapacity')
  const preparationMinutes = numberField(form, 'preparationMinutes')

  const result = await post<{ id: string }>('/api/v1/admin/catalog/offerings', {
    bakeryBranchId: field(form, 'bakeryBranchId'),
    productVariantId: field(form, 'productVariantId'),
    price,
    ...(dailyCapacity !== undefined && { dailyCapacity }),
    ...(preparationMinutes !== undefined && { preparationMinutes }),
    stockTracked: stockOnHand !== undefined,
    ...(stockOnHand !== undefined && { stockOnHand }),
    reason: field(form, 'reason') || 'قیمت‌گذاری از پنل مدیریت',
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت عرضه ناموفق بود.'))
  revalidatePath('/admin/pricing')
  return success('عرضه به صورت پیش‌نویس ثبت شد. تا انتشار، به مشتری نمایش داده نمی‌شود.')
}

export async function repriceOfferingAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const price = priceField(form, 'price')
  if (!price) return failure('قیمت باید عددی مثبت به ریال باشد.')
  const result = await patch(`/api/v1/admin/catalog/offerings/${field(form, 'offeringId')}`, {
    price,
    reason: field(form, 'reason') || 'تغییر قیمت از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر قیمت ناموفق بود.'))
  revalidatePath('/admin/pricing')
  return success('قیمت جدید ثبت شد. سفارش‌های ثبت‌شده با قیمت خودشان می‌مانند.')
}

export async function setOfferingAvailabilityAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const availability = field(form, 'availability')
  const result = await patch(`/api/v1/admin/catalog/offerings/${field(form, 'offeringId')}`, {
    availability,
    reason: field(form, 'reason') || 'تغییر وضعیت عرضه از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت عرضه ناموفق بود.'))
  revalidatePath('/admin/pricing')
  return success(
    availability === 'AVAILABLE' ? 'عرضه منتشر شد و قابل سفارش است.' : 'عرضه از فروش خارج شد.',
  )
}

export async function setOfferingStockAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const tracked = field(form, 'stockTracked') === 'true'
  const stockOnHand = numberField(form, 'stockOnHand')
  if (tracked && stockOnHand === undefined && field(form, 'stockOnHand') !== '0') {
    return failure('برای شمارش موجودی، تعداد موجود را وارد کنید.')
  }
  const result = await patch(`/api/v1/admin/catalog/offerings/${field(form, 'offeringId')}`, {
    stock: {
      stockTracked: tracked,
      stockOnHand: tracked ? (stockOnHand ?? 0) : null,
    },
    reason: field(form, 'reason') || 'به‌روزرسانی موجودی از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'ثبت موجودی ناموفق بود.'))
  revalidatePath('/admin/pricing')
  return success(tracked ? 'موجودی ثبت شد.' : 'شمارش موجودی برای این عرضه خاموش شد.')
}

/** Comma or newline separated free text into a list, with blanks discarded. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,\n،]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 50)
}

// ---------------------------------------------------------------------------
// Staff access
// ---------------------------------------------------------------------------

/**
 * Normalises a mobile number typed however the operator types it — Persian
 * digits, a leading zero, spaces — into the +989xxxxxxxxx form the API takes.
 * Anything that does not land on exactly that shape is refused rather than
 * patched into something plausible: granting a role to the wrong number is not
 * a mistake worth guessing at.
 */
function mobileField(form: FormData, name: string): string | null {
  const latin = field(form, name)
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[\s-]/g, '')
  const normalised = latin.startsWith('09')
    ? `+98${latin.slice(1)}`
    : latin.startsWith('989')
      ? `+${latin}`
      : latin
  return /^\+989\d{9}$/.test(normalised) ? normalised : null
}

export async function grantRoleAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const mobileE164 = mobileField(form, 'mobileE164')
  if (!mobileE164) return failure('شمارهٔ موبایل باید به شکل ۰۹xxxxxxxxx باشد.')

  const result = await post<{ mobileE164: string }>('/api/v1/admin/access/grants', {
    mobileE164,
    roleCode: field(form, 'roleCode'),
    reason: field(form, 'reason') || 'اعطای دسترسی از پنل مدیریت',
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'اعطای نقش ناموفق بود.'))
  revalidatePath('/admin/access')
  return success('نقش داده شد. تغییر بلافاصله اثر می‌کند.')
}

export async function revokeRoleAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await post('/api/v1/admin/access/revocations', {
    grantId: field(form, 'grantId'),
    reason: field(form, 'reason') || 'لغو دسترسی از پنل مدیریت',
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'لغو نقش ناموفق بود.'))
  revalidatePath('/admin/access')
  return success('نقش لغو شد.')
}

// ---------------------------------------------------------------------------
// Order operations
// ---------------------------------------------------------------------------

/**
 * Each step is its own route, so the form names the step rather than sending a
 * destination the server has to interpret. A typo in an enum would be a refund.
 */
const ORDER_STEPS: Readonly<Record<string, string>> = {
  accept: 'accept',
  reject: 'reject',
  cancel: 'cancel',
  'start-fulfillment': 'start-fulfillment',
  complete: 'complete',
}

const ORDER_STEP_SUCCESS: Readonly<Record<string, string>> = {
  accept: 'سفارش پذیرفته شد و به نانوایی رفت.',
  reject: 'سفارش رد شد.',
  cancel: 'سفارش لغو شد و در صورت پرداخت، مبلغ بازگردانده شد.',
  'start-fulfillment': 'سفارش وارد مرحلهٔ تحویل شد.',
  complete: 'سفارش تکمیل شد.',
}

export async function advanceOrderAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const orderId = field(form, 'orderId')
  const step = ORDER_STEPS[field(form, 'step')]
  if (!step) return failure('این مرحله شناخته نشد.')

  const result = await post(`/api/v1/admin/orders/${orderId}/${step}`, {
    reason: field(form, 'reason') || 'اقدام از پنل مدیریت',
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'این مرحله انجام نشد.'))
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath('/admin/orders')
  return success(ORDER_STEP_SUCCESS[step] ?? 'انجام شد.')
}

export async function advanceProductionAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const orderId = field(form, 'orderId')
  const result = await post(`/api/v1/admin/orders/${orderId}/production`, {
    to: field(form, 'to'),
    reason: field(form, 'reason') || 'به‌روزرسانی تولید از پنل مدیریت',
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت تولید انجام نشد.'))
  revalidatePath(`/admin/orders/${orderId}`)
  return success('وضعیت تولید ثبت شد.')
}

/**
 * Which variable the API objected to, in the operator's words.
 *
 * The server answers with the variable name because it is the only thing that
 * identifies which word in a paragraph of Persian was wrong. Translating it here
 * rather than showing `UNKNOWN_VARIABLE` means the operator can find the word
 * without knowing what a variable is.
 */
interface TemplateProblem {
  code: string
  name?: string
  length?: number
}

function templateProblemMessage(problem: TemplateProblem): string {
  switch (problem.code) {
    case 'UNKNOWN_VARIABLE':
      return `متغیر {${problem.name}} در این پیام وجود ندارد و همان‌طور برای مشتری فرستاده می‌شود.`
    case 'MISSING_REQUIRED_VARIABLE':
      return `متغیر {${problem.name}} اجباری است؛ بدون آن پیام بی‌فایده است.`
    case 'MALFORMED_PLACEHOLDER':
      return 'یک آکولاد بی‌جفت یا نام متغیر نادرست در متن هست.'
    case 'BODY_TOO_LONG':
      return `متن ${problem.length} کاراکتر است و از حد مجاز بیشتر است.`
    case 'EMPTY_BODY':
      return 'متن پیام خالی است.'
    default:
      return problem.code
  }
}

export async function saveMessageTemplateAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const purpose = field(form, 'purpose')
  const result = await put<{ segments: number }>(
    `/api/v1/admin/messaging/templates/SMS/${purpose}`,
    {
      body: field(form, 'body'),
      enabled: field(form, 'enabled') !== 'false',
    },
  )
  if (!result.ok) {
    const problems = (result.error as { details?: TemplateProblem[] }).details
    if (problems && problems.length > 0) {
      return failure(problems.map(templateProblemMessage).join(' '))
    }
    return failure(translateProviderError(result.error.code, 'ذخیرهٔ متن پیام ناموفق بود.'))
  }
  revalidatePath('/admin/messaging')
  return success(`ذخیره شد. این پیام ${result.data.segments} پیامک حساب می‌شود.`)
}

export async function offerDeliveryAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const taskId = field(form, 'taskId')
  const result = await post(`/api/v1/admin/deliveries/${taskId}/offer`, {
    courierId: field(form, 'courierId'),
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'اعزام انجام نشد.'))
  revalidatePath('/admin/deliveries')
  return success('سفارش به پیک پیشنهاد شد. تا وقتی نپذیرد، به مشتری چیزی گفته نمی‌شود.')
}

export async function releaseDeliveryAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const taskId = field(form, 'taskId')
  const result = await post(`/api/v1/admin/deliveries/${taskId}/release`, {
    ...(field(form, 'reason') && { reason: field(form, 'reason') }),
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'بازگرداندن به صف انجام نشد.'))
  revalidatePath('/admin/deliveries')
  return success('سفارش به صف اعزام برگشت.')
}

export async function createCourierAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await post('/api/v1/admin/couriers', {
    displayName: field(form, 'displayName'),
    mobileE164: field(form, 'mobileE164'),
  })
  if (!result.ok) return failure(translateProviderError(result.error.code, 'ثبت پیک انجام نشد.'))
  revalidatePath('/admin/deliveries')
  // Deliberately not available on creation: a courier who can be handed work the
  // instant their name is typed is one handed work before anyone checked.
  return success('پیک ثبت شد. برای اینکه سفارش بگیرد، وضعیتش را «فعال» کنید.')
}

export async function setCourierStatusAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const courierId = field(form, 'courierId')
  const result = await patch(`/api/v1/admin/couriers/${courierId}`, {
    status: field(form, 'status'),
  })
  if (!result.ok)
    return failure(translateProviderError(result.error.code, 'تغییر وضعیت پیک انجام نشد.'))
  revalidatePath('/admin/deliveries')
  return success('وضعیت پیک ثبت شد.')
}
