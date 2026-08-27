import 'server-only'

import type {
  ActiveCitySummary,
  AddressSummary,
  CartSummary,
  OrderSummary,
  PaymentSummary,
  ProductSummary,
  QuoteSummary,
  SessionContext,
} from '@alo-noon/contracts'

import {
  isUuid,
  request,
  requestWithPagination,
  type ApiResult,
  type PaginationMeta,
} from './api-core'

/**
 * The storefront's view of the API.
 *
 * Every shape here is the contract package's own type rather than a hand-copied
 * interface. That is the point of having versioned transport contracts: when a
 * field moves, this file fails to compile instead of quietly rendering
 * `undefined` where a price should be.
 *
 * The transport — tenant host, session cookie, timeouts, envelope unwrapping —
 * is shared with the admin panel in `api-core`. It runs only on the server, so a
 * customer's session cookie is never readable by page scripts.
 */

/* ------------------------------------------------------------- discovery */

export async function listCities(): Promise<ApiResult<ActiveCitySummary[]>> {
  return request<ActiveCitySummary[]>('/api/v1/serviceability/cities', { method: 'GET' })
}

export interface ServiceabilityAnswer {
  serviceable: boolean
  cityId?: string
  operationalZoneId?: string
  serviceAreaId?: string
  reasonCode?: string
}

export async function checkServiceability(
  latitude: number,
  longitude: number,
): Promise<ApiResult<ServiceabilityAnswer>> {
  return request<ServiceabilityAnswer>('/api/v1/serviceability/check', {
    method: 'POST',
    body: { latitude, longitude },
  })
}

export async function listProducts(
  cityId: string,
  options: { operationalZoneId?: string; page?: number; pageSize?: number } = {},
): Promise<ApiResult<ProductSummary[]> & { pagination?: PaginationMeta }> {
  if (!isUuid(cityId)) {
    return { ok: false, error: { code: 'CITY_NOT_FOUND', message: 'شهر انتخابی معتبر نیست.' } }
  }
  const query = new URLSearchParams({
    cityId,
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 60),
    ...(options.operationalZoneId && { operationalZoneId: options.operationalZoneId }),
  })
  return requestWithPagination<ProductSummary[]>(`/api/v1/catalog/products?${query.toString()}`)
}

/* -------------------------------------------------------------- identity */

export async function readSession(): Promise<ApiResult<SessionContext>> {
  return request<SessionContext>('/api/v1/auth/session', { method: 'GET' })
}

/**
 * The signed-in customer, or nobody.
 *
 * A failed session read is not an error worth showing anyone: most visitors to
 * a shop are not signed in, and that is the normal case rather than a fault.
 */
export async function currentSession(): Promise<SessionContext | null> {
  const result = await readSession()
  return result.ok ? result.data : null
}

/**
 * Revokes the session on the API.
 *
 * Deleting only the browser cookie would leave a usable session alive on the
 * server for its full life — on a shared or stolen device, "signed out" would
 * be a label rather than a fact.
 */
export async function revokeShopSession(): Promise<void> {
  await request('/api/v1/auth/session', { method: 'DELETE' })
}

/* ---------------------------------------------------------------- basket */

export async function readCart(): Promise<ApiResult<CartSummary | null>> {
  return request<CartSummary | null>('/api/v1/cart', { method: 'GET' })
}

/**
 * Puts a quantity of one offering into the cart.
 *
 * `expectedCartVersion` is the cart's optimistic concurrency: the API refuses a
 * write decided against a version somebody else has since replaced. It is
 * optional because the very first write happens when there is no cart at all,
 * and sending a version then is refused.
 */
export async function setCartItem(
  offeringId: string,
  input: {
    cityId: string
    operationalZoneId: string
    quantity: number
    expectedCartVersion?: number
  },
): Promise<ApiResult<CartSummary>> {
  if (!isUuid(offeringId)) {
    return { ok: false, error: { code: 'OFFERING_NOT_FOUND', message: 'این محصول یافت نشد.' } }
  }
  return request<CartSummary>(`/api/v1/cart/items/${offeringId}`, { method: 'PUT', body: input })
}

export async function removeCartItem(
  offeringId: string,
  expectedCartVersion?: number,
): Promise<ApiResult<CartSummary>> {
  if (!isUuid(offeringId)) {
    return { ok: false, error: { code: 'OFFERING_NOT_FOUND', message: 'این محصول یافت نشد.' } }
  }
  return request<CartSummary>(`/api/v1/cart/items/${offeringId}`, {
    method: 'DELETE',
    body: expectedCartVersion === undefined ? {} : { expectedCartVersion },
  })
}

/* ------------------------------------------------------------- addresses */

export async function listAddresses(): Promise<ApiResult<AddressSummary[]>> {
  return request<AddressSummary[]>('/api/v1/addresses', { method: 'GET' })
}

export async function createAddress(input: {
  label: string
  recipientName: string
  recipientPhone: string
  addressLine: string
  latitude: number
  longitude: number
  postalCode?: string
  deliveryInstructions?: string
}): Promise<ApiResult<AddressSummary>> {
  return request<AddressSummary>('/api/v1/addresses', { method: 'POST', body: input })
}

/* ------------------------------------------------------- quote and order */

export async function createQuote(input: {
  deliveryAddressId: string
  expectedCartVersion: number
  idempotencyKey: string
}): Promise<ApiResult<QuoteSummary>> {
  return request<QuoteSummary>('/api/v1/cart/quote', { method: 'POST', body: input })
}

export async function placeOrder(input: {
  quoteId: string
  idempotencyKey: string
}): Promise<ApiResult<OrderSummary>> {
  return request<OrderSummary>('/api/v1/orders', { method: 'POST', body: input })
}

export async function listOrders(): Promise<ApiResult<OrderSummary[]>> {
  return request<OrderSummary[]>('/api/v1/orders', { method: 'GET' })
}

export async function readOrder(orderId: string): Promise<ApiResult<OrderSummary>> {
  if (!isUuid(orderId)) {
    return { ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'سفارش یافت نشد.' } }
  }
  return request<OrderSummary>(`/api/v1/orders/${orderId}`, { method: 'GET' })
}

/* --------------------------------------------------------------- payment */

export async function createPayment(input: {
  orderId: string
  idempotencyKey: string
}): Promise<ApiResult<PaymentSummary>> {
  return request<PaymentSummary>('/api/v1/payments', { method: 'POST', body: input })
}

export interface PaymentHandoff {
  paymentId: string
  outcome: string
  /** Where to send the customer's browser. Absent when the gateway refused. */
  customerActionUrl?: string
  providerCode?: string
}

export async function initializePayment(input: {
  paymentId: string
  idempotencyKey: string
}): Promise<ApiResult<PaymentHandoff>> {
  return request<PaymentHandoff>('/api/v1/payments/initialize', { method: 'POST', body: input })
}

export async function readPayment(paymentId: string): Promise<ApiResult<PaymentSummary>> {
  if (!isUuid(paymentId)) {
    return { ok: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'پرداخت یافت نشد.' } }
  }
  return request<PaymentSummary>(`/api/v1/payments/${paymentId}`, { method: 'GET' })
}
