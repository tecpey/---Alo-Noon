import 'server-only'

import { cookies, headers } from 'next/headers'

import { decodeEnvelope, sessionTokenFromSetCookie as pickCookie } from './api-envelope'
import type { ApiFailure, ApiResult } from './api-envelope'

export type { ApiFailure, ApiResult }
export { isUnauthenticated, isUuid } from './api-envelope'

/**
 * The one way this application talks to the API.
 *
 * Every call runs on the Next.js server, never in the browser. A customer's
 * session stays an HttpOnly cookie that client JavaScript cannot read, and no
 * credential the API holds is ever handed to a page.
 *
 * Tenant resolution is the subtle part, and it is why this is shared rather than
 * written twice. The API decides which tenant a request belongs to from the host
 * it arrives on, and Node's fetch refuses to let a caller set `Host` — undici
 * derives it from the URL and drops any override. So the host the API sees is
 * the host in the base URL, and that value must name the tenant, not an internal
 * upstream address.
 *
 * `X-Forwarded-Host` carries the browser's host as well. A deployment that has
 * declared its proxy hops (`API_TRUST_PROXY_HOPS`) will prefer it, which lets one
 * deployment serve several tenant hosts; one that has not will fall back to the
 * base URL's host, which is why that must be right on its own.
 *
 * Beyond those, only `Cookie` is forwarded, restricted to the session cookie, so
 * the API authenticates the caller exactly as it would a direct request.
 */
export const SESSION_COOKIE = 'alo_session'

const REQUEST_TIMEOUT_MS = 10_000

export interface Money {
  amount: string
  currency: 'IRR'
}

export interface PaginationMeta {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

/**
 * Where the API lives.
 *
 * `API_BASE_URL` is the name to use. `ADMIN_API_BASE_URL` is honoured because
 * deployments were configured with it before the storefront existed, and
 * renaming an environment variable under a running service is how a launch
 * turns into an outage.
 */
export function apiBaseUrl(): string {
  return process.env['API_BASE_URL'] ?? process.env['ADMIN_API_BASE_URL'] ?? 'http://localhost:3001'
}

export async function upstreamHeaders(): Promise<Record<string, string>> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  const session = cookieStore.get(SESSION_COOKIE)
  const browserHost = headerStore.get('x-forwarded-host') ?? headerStore.get('host')
  return {
    accept: 'application/json',
    ...(browserHost && { 'x-forwarded-host': browserHost }),
    ...(session && { cookie: `${SESSION_COOKIE}=${session.value}` }),
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Extra headers — an idempotency key, or a session token not yet in a cookie. */
  headers?: Record<string, string>
  /** Returned alongside the result, for routes that publish a Set-Cookie. */
  wantSetCookie?: boolean
}

export interface RawResult<T> {
  result: ApiResult<T>
  meta?: unknown
  setCookie?: string[]
}

export async function requestRaw<T>(path: string, init: RequestOptions): Promise<RawResult<T>> {
  let response: Response
  try {
    response = await fetch(new URL(path, apiBaseUrl()), {
      method: init.method,
      headers: {
        ...(await upstreamHeaders()),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      // Nothing here is safe to serve stale: a price, a basket, a delivery state
      // and a payment verdict are all things a customer acts on immediately.
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return {
      result: {
        ok: false,
        error: { code: 'API_UNREACHABLE', message: 'ارتباط با سرویس برقرار نشد.' },
      },
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  const setCookie = init.wantSetCookie ? response.headers.getSetCookie() : undefined
  const { result, meta } = decodeEnvelope<T>(response.status, response.ok, payload)

  return {
    result,
    ...(meta !== undefined && { meta }),
    ...(setCookie && { setCookie }),
  }
}

export async function request<T>(path: string, init: RequestOptions): Promise<ApiResult<T>> {
  return (await requestRaw<T>(path, init)).result
}

/** Same as `request`, but surfaces the pagination block the list routes attach. */
export async function requestWithPagination<T>(
  path: string,
): Promise<ApiResult<T> & { pagination?: PaginationMeta }> {
  const { result, meta } = await requestRaw<T>(path, { method: 'GET' })
  const pagination = (meta as { pagination?: PaginationMeta } | undefined)?.pagination
  return pagination ? { ...result, pagination } : result
}

/**
 * A POST used before there is a session — signing in.
 *
 * It cannot go through `request`: verifying a code has to read the API's raw
 * `Set-Cookie` headers to relay the session, and the envelope helper abstracts
 * the response away. Returns null rather than throwing when the API is
 * unreachable, which is a state both callers already render.
 */
export async function authPost(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response | null> {
  try {
    return await fetch(new URL(path, apiBaseUrl()), {
      method: 'POST',
      headers: {
        ...(await upstreamHeaders()),
        'content-type': 'application/json',
        ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

/** Picks the session token out of the API's Set-Cookie headers. */
export function sessionTokenFromSetCookie(
  setCookies: readonly string[],
  cookieName: string = SESSION_COOKIE,
): string | null {
  return pickCookie(setCookies, cookieName)
}
