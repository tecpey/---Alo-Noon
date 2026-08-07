import 'server-only'

import { cookies, headers } from 'next/headers'

/**
 * Server-side client for the admin API.
 *
 * Every call runs on the Next.js server, never in the browser. The operator's
 * session stays an HttpOnly cookie that client JavaScript cannot read, and no
 * provider credential reference is ever handed to the browser beyond what the
 * API itself publishes.
 *
 * Tenant resolution is the subtle part. The API decides which tenant a request
 * belongs to from the host it arrives on, and Node's fetch refuses to let a
 * caller set `Host` — undici derives it from the URL and drops any override. So
 * the host the API sees is the host in `ADMIN_API_BASE_URL`, and that value must
 * name the tenant, not an internal upstream address.
 *
 * `X-Forwarded-Host` carries the browser's host as well. A deployment that has
 * already declared its proxy hops (`API_TRUST_PROXY_HOPS`) will prefer it, which
 * lets one panel serve several tenant hosts; a deployment that has not will fall
 * back to the base URL's host, which is why that must be right on its own.
 *
 * Beyond those, only `Cookie` is forwarded, restricted to the session cookie, so
 * the API authenticates the operator exactly as it would a direct request.
 */
const SESSION_COOKIE = 'alo_session'
const REQUEST_TIMEOUT_MS = 10_000

export interface ApiFailure {
  code: string
  message: string
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure }

export function adminApiBaseUrl(): string {
  return process.env['ADMIN_API_BASE_URL'] ?? 'http://localhost:3001'
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

async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(new URL(path, adminApiBaseUrl()), {
      method: init.method,
      headers: {
        ...(await upstreamHeaders()),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      // Provider state is governance data; a stale read here would show an
      // operator a gateway as live after they took it out of rotation.
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: { code: 'API_UNREACHABLE', message: 'ارتباط با سرویس برقرار نشد.' } }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload.error as ApiFailure)
        : { code: `HTTP_${response.status}`, message: 'درخواست ناموفق بود.' }
    return { ok: false, error }
  }
  return { ok: true, data: (payload as { data: T }).data }
}

export interface PaymentConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  merchantReference: string
  environment: 'TEST' | 'PRODUCTION'
  capabilities: string[]
  credentialReferenceId: string
  isActive: boolean
  isDefault: boolean
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  governanceVersion: number
  updatedAt: string
}

export interface SmsConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  senderReference: string
  templateReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  createdAt: string
}

/**
 * True when the API refused the request for lack of a session, as opposed to
 * lack of permission. Only the first sends the operator back to sign in — a
 * signed-in account without the governance grant needs to be told that, not
 * bounced through a login it will complete successfully and land right back.
 */
export function isUnauthenticated(error: ApiFailure): boolean {
  return error.code === 'SESSION_UNAUTHORIZED'
}

export async function listPaymentConfigurations(): Promise<
  ApiResult<PaymentConfigurationSummary[]>
> {
  return request<PaymentConfigurationSummary[]>('/api/v1/admin/payment-providers/configurations', {
    method: 'GET',
  })
}

export async function listSmsConfigurations(): Promise<ApiResult<SmsConfigurationSummary[]>> {
  return request<SmsConfigurationSummary[]>('/api/v1/admin/sms-providers/configurations', {
    method: 'GET',
  })
}

export async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'POST', body })
}

/**
 * Revokes the session server-side. Clearing only the browser cookie would leave
 * a usable session behind on the API for its full 30-day life.
 */
export async function revokeSession(): Promise<void> {
  await request('/api/v1/auth/session', { method: 'DELETE' })
}
