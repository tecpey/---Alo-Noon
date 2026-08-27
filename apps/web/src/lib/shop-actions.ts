'use server'

import { randomUUID } from 'node:crypto'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import type { ActionState } from './action-state'
import { authPost, sessionTokenFromSetCookie, SESSION_COOKIE } from './api-core'
import { translateProviderError } from './admin-format'
import { CITY_COOKIE, ZONE_COOKIE } from './shop-cookies'
import { normalizeMobile, normalizeOtpCode } from './shop-format'
import { removeCartItem, revokeShopSession, setCartItem } from './shop-api'

/**
 * The customer's side of the shop, as Server Actions.
 *
 * Nothing here runs in the browser. The session token never reaches page
 * scripts, and every basket write goes through the API's own optimistic
 * concurrency rather than through anything this application decides.
 *
 * Each action returns a message for the form rather than throwing: a customer
 * halfway through signing in needs to see which step failed, not an error page
 * that loses the number they just typed.
 */
const CHALLENGE_COOKIE = 'alo_shop_challenge'

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim()
}

export async function requestShopOtpAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const mobileE164 = normalizeMobile(field(form, 'mobileE164'))
  if (!mobileE164) {
    return { status: 'error', message: 'شمارهٔ موبایل معتبر نیست. مثل ۰۹۱۲۱۲۳۴۵۶۷ وارد کنید.' }
  }

  const response = await authPost('/api/v1/auth/otp/request', { mobileE164 }, randomUUID())
  if (!response) return { status: 'error', message: 'ارتباط با سرویس برقرار نشد.' }

  const payload = (await response.json().catch(() => null)) as {
    data?: { challengeId?: string }
    error?: { code?: string }
  } | null
  if (!response.ok || !payload?.data?.challengeId) {
    return {
      status: 'error',
      message: translateProviderError(payload?.error?.code ?? 'UNKNOWN', 'ارسال کد ناموفق بود.'),
    }
  }

  // The challenge id names which challenge the next step verifies. It is not a
  // credential, but it has no reason to reach the URL bar or browser history.
  const cookieStore = await cookies()
  cookieStore.set(CHALLENGE_COOKIE, payload.data.challengeId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 10 * 60,
  })
  return { status: 'ok', message: 'کد تأیید برای همان شماره ارسال شد.' }
}

export async function verifyShopOtpAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const cookieStore = await cookies()
  const challengeId = cookieStore.get(CHALLENGE_COOKIE)?.value
  if (!challengeId) return { status: 'error', message: 'ابتدا کد تأیید را درخواست کنید.' }

  const response = await authPost('/api/v1/auth/otp/verify', {
    challengeId,
    code: normalizeOtpCode(field(form, 'code')),
  })
  if (!response) return { status: 'error', message: 'ارتباط با سرویس برقرار نشد.' }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string }
    } | null
    return {
      status: 'error',
      message: translateProviderError(payload?.error?.code ?? 'UNKNOWN', 'کد تأیید پذیرفته نشد.'),
    }
  }

  // The API issues the session only as a Set-Cookie; the body never carries the
  // token. Relay it, and keep it HttpOnly on this origin too.
  const token = sessionTokenFromSetCookie(response.headers.getSetCookie())
  if (!token) return { status: 'error', message: 'نشست ایجاد نشد. دوباره تلاش کنید.' }
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  cookieStore.delete(CHALLENGE_COOKIE)
  redirect('/account')
}

export async function signOutShopAction(): Promise<void> {
  // Revoke on the API first: dropping only the browser cookie would leave a
  // usable session alive for its full lifetime, which on a shared device means
  // "signed out" is a label rather than a fact.
  await revokeShopSession()
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
  redirect('/')
}

/**
 * Remembers which city the customer is shopping in.
 *
 * A cookie rather than a query parameter: the choice has to survive every link
 * on the site, and a city that falls out of the URL is a catalogue that
 * silently empties.
 */
export async function selectCityAction(form: FormData): Promise<void> {
  const cityId = field(form, 'cityId')
  const zoneId = field(form, 'operationalZoneId')
  const cookieStore = await cookies()
  const year = { httpOnly: false, sameSite: 'lax' as const, path: '/', maxAge: 365 * 24 * 60 * 60 }
  if (cityId) cookieStore.set(CITY_COOKIE, cityId, year)
  if (zoneId) cookieStore.set(ZONE_COOKIE, zoneId, year)
  revalidatePath('/')
}

/* --------------------------------------------------------------- basket */

/**
 * Adds one of something to the cart.
 *
 * The quantity is read from the cart rather than sent blind, because the API's
 * write is a `PUT` of an absolute quantity and two taps in quick succession
 * would otherwise both write "1".
 */
export async function addToCartAction(form: FormData): Promise<void> {
  const offeringId = field(form, 'offeringId')
  const cityId = field(form, 'cityId')
  const operationalZoneId = field(form, 'operationalZoneId')
  const quantity = Number(field(form, 'quantity') || '1')
  const rawVersion = field(form, 'expectedCartVersion')
  const expectedCartVersion = rawVersion ? Number(rawVersion) : undefined

  await setCartItem(offeringId, {
    cityId,
    operationalZoneId,
    quantity: Math.max(1, Math.min(100, quantity)),
    ...(expectedCartVersion !== undefined &&
      Number.isFinite(expectedCartVersion) && { expectedCartVersion }),
  })
  revalidatePath('/')
}

export async function removeFromCartAction(form: FormData): Promise<void> {
  const offeringId = field(form, 'offeringId')
  const rawVersion = field(form, 'expectedCartVersion')
  const quantity = Number(field(form, 'quantity') || '0')
  const cityId = field(form, 'cityId')
  const operationalZoneId = field(form, 'operationalZoneId')
  const expectedCartVersion = rawVersion ? Number(rawVersion) : undefined

  // One fewer, or gone entirely at one. A decrement that deleted the line would
  // lose a customer's other four loaves the first time they tapped minus.
  if (quantity > 1) {
    await setCartItem(offeringId, {
      cityId,
      operationalZoneId,
      quantity: quantity - 1,
      ...(expectedCartVersion !== undefined &&
        Number.isFinite(expectedCartVersion) && { expectedCartVersion }),
    })
  } else {
    await removeCartItem(
      offeringId,
      expectedCartVersion !== undefined && Number.isFinite(expectedCartVersion)
        ? expectedCartVersion
        : undefined,
    )
  }
  revalidatePath('/')
}
