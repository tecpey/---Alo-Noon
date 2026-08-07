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

/** Same as `request`, but surfaces the pagination block the list routes attach. */
async function requestWithPagination<T>(
  path: string,
): Promise<ApiResult<T> & { pagination?: PaginationMeta }> {
  const { result, meta } = await requestRaw<T>(path, { method: 'GET' })
  const pagination = (meta as { pagination?: PaginationMeta } | undefined)?.pagination
  return pagination ? { ...result, pagination } : result
}

async function request<T>(path: string, init: RequestInit_): Promise<ApiResult<T>> {
  return (await requestRaw<T>(path, init)).result
}

interface RequestInit_ {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

async function requestRaw<T>(
  path: string,
  init: RequestInit_,
): Promise<{ result: ApiResult<T>; meta?: unknown }> {
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

  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload.error as ApiFailure)
        : { code: `HTTP_${response.status}`, message: 'درخواست ناموفق بود.' }
    return { result: { ok: false, error } }
  }
  const envelope = payload as { data: T; meta?: unknown }
  return { result: { ok: true, data: envelope.data }, meta: envelope.meta }
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

export interface SalesReport {
  range: { from: string; to: string }
  totals: {
    placedOrders: number
    placedValue: Money
    paidOrders: number
    paidValue: Money
    cancelledOrders: number
    cancelledValue: Money
    averageOrderValue: Money
    deliveryFees: Money
    discounts: Money
  }
  ordersByState: Record<string, number>
  ordersByPaymentState: Record<string, number>
  daily: Array<{ date: string; placedOrders: number; placedValue: Money }>
  topProducts: Array<{
    sku: string
    productNameFa: string
    variantNameFa: string
    quantity: number
    revenue: Money
  }>
  conversion: { carts: number; quotes: number; orders: number; quoteToOrderRate: number | null }
}

export interface Money {
  amount: string
  currency: 'IRR'
}

export interface AdminOrderSummary {
  id: string
  publicId: string
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
  customerId: string
  recipientNameSnapshot: string
  bakeryNameSnapshot: string
  totalAmount: Money
  itemCount: number
  requestedDeliveryAt: string | null
  createdAt: string
}

export interface AdminOrderDetail extends AdminOrderSummary {
  subtotalAmount: Money
  deliveryFeeAmount: Money
  discountAmount: Money
  recipientPhoneSnapshot: string
  deliveryAddressSnapshot: string
  deliveryInstructionsSnapshot: string | null
  customerNotes: string | null
  cancellationReasonCode: string | null
  items: Array<{
    sku: string
    productNameFa: string
    variantNameFa: string
    quantity: number
    unitPrice: Money
    lineTotal: Money
  }>
  transitions: Array<{
    fromState: string | null
    toState: string
    reasonCode: string | null
    occurredAt: string
  }>
  updatedAt: string
}

export interface PaginationMeta {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export async function readSalesReport(from: string, to: string): Promise<ApiResult<SalesReport>> {
  const query = new URLSearchParams({ from, to })
  return request<SalesReport>(`/api/v1/admin/reports/sales?${query.toString()}`, { method: 'GET' })
}

export async function listOrders(
  params: Readonly<Record<string, string>>,
): Promise<ApiResult<AdminOrderSummary[]> & { pagination?: PaginationMeta }> {
  const query = new URLSearchParams(params)
  return requestWithPagination<AdminOrderSummary[]>(`/api/v1/admin/orders?${query.toString()}`)
}

export async function readOrder(orderId: string): Promise<ApiResult<AdminOrderDetail>> {
  // The id is interpolated into a path segment, so anything that could change
  // the path's shape is refused before the request rather than sent upstream.
  if (!/^[0-9a-fA-F-]{36}$/.test(orderId)) {
    return { ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'شناسهٔ سفارش معتبر نیست.' } }
  }
  return request<AdminOrderDetail>(`/api/v1/admin/orders/${orderId}`, { method: 'GET' })
}

export async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'POST', body })
}

export async function patch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'PATCH', body })
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogCategory {
  id: string
  code: string
  nameFa: string
  productCount: number
}

export interface AdminVariant {
  id: string
  productId: string
  sku: string
  nameFa: string
  fulfillmentClass: string
  freshnessClaim: string
  productionMode: string
  fulfillmentControl: string
  lifecycle: string
  ingredients: string[]
  allergens: string[]
  dietaryAttributes: string[]
  offeringCount: number
}

export interface AdminProduct {
  id: string
  categoryId: string
  categoryNameFa: string
  slug: string
  nameFa: string
  descriptionFa: string | null
  mediaRef: string | null
  lifecycle: string
  variants: AdminVariant[]
  createdAt: string
  updatedAt: string
}

export interface AdminBranch {
  id: string
  bakeryId: string
  bakeryNameFa: string
  cityId: string
  code: string
  nameFa: string
  operationalStatus: string
  qualityStatus: string
  offeringCount: number
}

export interface AdminOffering {
  id: string
  bakeryBranchId: string
  branchNameFa: string
  productVariantId: string
  sku: string
  productNameFa: string
  variantNameFa: string
  variantLifecycle: string
  price: Money
  availability: string
  dailyCapacity: number | null
  preparationMinutes: number | null
  stockTracked: boolean
  stockOnHand: number | null
  availableFrom: string | null
  availableUntil: string | null
  updatedAt: string
}

export async function listCatalogCategories(): Promise<ApiResult<CatalogCategory[]>> {
  return request<CatalogCategory[]>('/api/v1/admin/catalog/categories', { method: 'GET' })
}

export async function listCatalogProducts(
  params: Readonly<Record<string, string>>,
): Promise<ApiResult<AdminProduct[]> & { pagination?: PaginationMeta }> {
  const query = new URLSearchParams(params)
  return requestWithPagination<AdminProduct[]>(`/api/v1/admin/catalog/products?${query.toString()}`)
}

export async function listCatalogBranches(): Promise<ApiResult<AdminBranch[]>> {
  return request<AdminBranch[]>('/api/v1/admin/catalog/branches', { method: 'GET' })
}

export async function listCatalogOfferings(
  params: Readonly<Record<string, string>>,
): Promise<ApiResult<AdminOffering[]> & { pagination?: PaginationMeta }> {
  const query = new URLSearchParams(params)
  return requestWithPagination<AdminOffering[]>(
    `/api/v1/admin/catalog/offerings?${query.toString()}`,
  )
}

/**
 * Revokes the session server-side. Clearing only the browser cookie would leave
 * a usable session behind on the API for its full 30-day life.
 */
export async function revokeSession(): Promise<void> {
  await request('/api/v1/auth/session', { method: 'DELETE' })
}
