'use server'

import { randomUUID } from 'node:crypto'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import type { CartSummary } from '@alo-noon/contracts'

import type { ActionState } from './action-state'
import { authPost, isUnauthenticated, sessionTokenFromSetCookie, SESSION_COOKIE } from './api-core'
import { translateProviderError } from './admin-format'
import { linesFromCart, mergePlan, type BasketLine } from './basket-lines'
import { toPersianDigits } from './persian'
import { CITY_COOKIE, ZONE_COOKIE } from './shop-cookies'
import { normalizeMobile, normalizeOtpCode } from './shop-format'
import { readCart, removeCartItem, revokeShopSession, setCartItem } from './shop-api'
import { offeringContexts } from './storefront-data'

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

export interface BasketResult {
  /** Null when nobody is signed in: the basket stays in the browser. */
  cart: CartSummary | null
  /** Persian text for what went wrong, or null when nothing did. */
  error: string | null
}

/**
 * The signed-in customer's cart, or nothing.
 *
 * A missing session is not an error here. Most people looking at a bread shop
 * are not signed in, and the basket they are building lives in their browser
 * until they are.
 */
export async function readBasketAction(): Promise<BasketResult> {
  const result = await readCart()
  if (result.ok) return { cart: result.data, error: null }
  if (isUnauthenticated(result.error)) return { cart: null, error: null }
  return { cart: null, error: translateProviderError(result.error.code, 'سبد خرید خوانده نشد.') }
}

/**
 * Sets the quantity of one bread to an exact number.
 *
 * The API's write is a `PUT` of an absolute quantity rather than a delta, which
 * is what makes a double-tapped button safe: two identical writes leave two
 * loaves in the basket, where two increments would leave four.
 *
 * `expectedCartVersion` is passed straight through. When the server rejects it,
 * somebody else — another tab, the phone app — moved the cart first, and the
 * caller is told to re-read rather than having its stale number forced through.
 */
export async function setBasketQuantityAction(input: {
  offeringId: string
  cityId: string
  operationalZoneId: string
  quantity: number
  expectedCartVersion?: number
}): Promise<BasketResult> {
  const quantity = Math.trunc(input.quantity)
  const result =
    quantity <= 0
      ? await removeCartItem(input.offeringId, input.expectedCartVersion)
      : await setCartItem(input.offeringId, {
          cityId: input.cityId,
          operationalZoneId: input.operationalZoneId,
          quantity: Math.min(100, quantity),
          ...(input.expectedCartVersion !== undefined && {
            expectedCartVersion: input.expectedCartVersion,
          }),
        })

  if (result.ok) {
    // The header's basket count and the shelves are rendered on the server, so
    // a write that did not revalidate would leave the page disagreeing with the
    // cart it just changed.
    revalidatePath('/')
    return { cart: result.data, error: null }
  }
  if (isUnauthenticated(result.error)) return { cart: null, error: null }
  return { cart: null, error: translateProviderError(result.error.code, 'سبد خرید به‌روز نشد.') }
}

/**
 * Carries a browser basket onto the server cart after signing in.
 *
 * Lines are written one at a time because the API has no bulk write, and the
 * cart's version moves on every one of them — so each write uses the version
 * the previous write returned rather than the one this function started with.
 * Sending a stale version would make the second loaf fail on a cart the first
 * loaf had just changed.
 *
 * A line the server refuses does not abort the rest. The usual reason is that
 * one bread stopped being available while the basket sat in a browser, and
 * losing the other four because of it would be a worse answer than saying so.
 */
export async function mergeBasketAction(lines: readonly BasketLine[]): Promise<BasketResult> {
  const current = await readCart()
  if (!current.ok) {
    if (isUnauthenticated(current.error)) return { cart: null, error: null }
    return { cart: null, error: translateProviderError(current.error.code, 'سبد خرید خوانده نشد.') }
  }

  const plan = mergePlan(
    new Map(lines.map((line) => [line.offeringId, line.quantity])),
    linesFromCart(current.data),
  )
  if (plan.length === 0) return { cart: current.data, error: null }

  const contexts = await offeringContexts()

  let cart = current.data
  let refused = 0
  for (const line of plan) {
    const context = contexts.get(line.offeringId)
    // Not on sale in this city any more. Nothing to write, and nothing the
    // customer can do about it — it is counted and reported, not retried.
    if (!context) {
      refused += 1
      continue
    }
    const result = await setCartItem(line.offeringId, {
      ...context,
      quantity: line.quantity,
      ...(cart && { expectedCartVersion: cart.version }),
    })
    if (result.ok) cart = result.data
    else refused += 1
  }

  revalidatePath('/')
  return {
    cart,
    error:
      refused > 0
        ? `${toPersianDigits(String(refused))} مورد از سبد شما دیگر موجود نیست و منتقل نشد.`
        : null,
  }
}
