'use server'

import { randomUUID } from 'node:crypto'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import type { ActionState } from './action-state'
import { adminApiBaseUrl, post, revokeSession, upstreamHeaders } from './admin-api'
import {
  derivedIdempotencyKey,
  PROVIDER_ERROR_MESSAGES,
  sessionTokenFromSetCookie,
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
  const response = await authFetch('/api/v1/auth/otp/request', { mobileE164 }, randomUUID())
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

  const response = await authFetch('/api/v1/auth/otp/verify', {
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
    capabilities: ['PAYMENT_INITIALIZATION'],
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
async function authFetch(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response | null> {
  try {
    return await fetch(new URL(path, adminApiBaseUrl()), {
      method: 'POST',
      headers: {
        ...(await upstreamHeaders()),
        'content-type': 'application/json',
        ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return null
  }
}
