import 'server-only'

import {
  apiBaseUrl,
  isUnauthenticated,
  isUuid,
  request,
  requestWithPagination,
  upstreamHeaders,
  type ApiFailure,
  type ApiResult,
  type Money,
  type PaginationMeta,
} from './api-core'

/**
 * The admin panel's view of the API.
 *
 * The transport itself — base URL, tenant host forwarding, session cookie,
 * timeouts, envelope unwrapping — lives in `api-core`, shared with the
 * storefront. Only the endpoints and their shapes are here. Two copies of that
 * transport is two places to get the `X-Forwarded-Host` subtlety wrong, and one
 * of them would be got wrong.
 */
export { isUnauthenticated, upstreamHeaders }
export type { ApiFailure, ApiResult, Money, PaginationMeta }

/** Kept under its old name: pages and server actions import it from here. */
export const adminApiBaseUrl = apiBaseUrl

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

export interface RoutingConfigurationSummary {
  id: string
  providerCode: string
  adapterVersion: string
  environment: 'TEST' | 'PRODUCTION'
  /**
   * The reference, never the key. Shown deliberately: an operator asking why
   * delivery distances look wrong needs to see which variable the engine is
   * reading from.
   */
  credentialReference: string
  enabled: boolean
  isDefault: boolean
  priority: number
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  createdAt: string
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

export async function listRoutingConfigurations(): Promise<
  ApiResult<RoutingConfigurationSummary[]>
> {
  return request<RoutingConfigurationSummary[]>('/api/v1/admin/routing-providers/configurations', {
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
  if (!isUuid(orderId)) {
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

export async function put<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: 'PUT', body })
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export interface MessageTemplateVariable {
  name: string
  required: boolean
  labelFa: string
  example: string
}

export interface MessageTemplate {
  channel: 'SMS'
  purpose: string
  labelFa: string
  descriptionFa: string
  body: string
  defaultBody: string
  customized: boolean
  enabled: boolean
  version: number
  variables: MessageTemplateVariable[]
  preview: string
  segments: number
  updatedAt: string | null
  updatedById: string | null
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface DeliveryTask {
  taskId: string
  orderId: string
  orderPublicId: string
  state: string
  attemptCount: number
  recipientName: string
  address: string
  bakeryName: string
  totalAmount: string
  deliverBefore: string | null
  courier: { courierId: string; displayName: string; assignmentId: string; state: string } | null
  updatedAt: string
}

export interface CourierSummary {
  courierId: string
  displayName: string
  mobileE164: string
  status: string
  activeTasks: number
}

export async function listDeliveries(): Promise<ApiResult<DeliveryTask[]>> {
  return request<DeliveryTask[]>('/api/v1/admin/deliveries', { method: 'GET' })
}

export async function listCouriers(): Promise<ApiResult<CourierSummary[]>> {
  return request<CourierSummary[]>('/api/v1/admin/couriers', { method: 'GET' })
}

/* ----------------------------------------------------------- the cash desk */

export interface CourierCashPosition {
  courierId: string
  courierName: string
  orderCount: number
  outstanding: { amount: string; currency: string }
}

export interface OutstandingCashOrder {
  orderId: string
  publicId: string
  amount: { amount: string; currency: string }
  collectedAt: string
}

/** How much cash each courier is carrying right now. */
export async function listCourierCashPositions(): Promise<ApiResult<CourierCashPosition[]>> {
  return request<CourierCashPosition[]>('/api/v1/admin/cash/outstanding', { method: 'GET' })
}

/** The individual orders one courier is still carrying cash for. */
export async function listCourierCashOrders(
  courierId: string,
): Promise<ApiResult<OutstandingCashOrder[]>> {
  return request<OutstandingCashOrder[]>(`/api/v1/admin/cash/couriers/${courierId}/orders`, {
    method: 'GET',
  })
}

export interface BranchQuality {
  bakeryBranchId: string
  branchNameFa: string
  bakeryNameFa: string
  qualityStatus: string
  sampleSize: number
  /** Mean bread score in hundredths — 425 is 4.25. */
  averageHundredths: number
  flagForReview: boolean
}

/** How every bakery branch is doing on the bread it bakes. */
export async function listBranchQuality(): Promise<ApiResult<BranchQuality[]>> {
  return request<BranchQuality[]>('/api/v1/admin/quality/branches', { method: 'GET' })
}

export async function listMessageTemplates(): Promise<ApiResult<MessageTemplate[]>> {
  const result = await request<{ templates: MessageTemplate[] }>(
    '/api/v1/admin/messaging/templates/SMS',
    { method: 'GET' },
  )
  return result.ok ? { ok: true, data: result.data.templates } : result
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

// ---------------------------------------------------------------------------
// Staff access
// ---------------------------------------------------------------------------

export interface AdminRoleSummary {
  code: string
  name: string
  permissions: string[]
  grantable: boolean
}

export interface StaffMember {
  accountId: string
  mobileE164: string
  status: string
  roles: Array<{
    grantId: string
    code: string
    name: string
    grantedAt: string
    expiresAt: string | null
  }>
  permissions: string[]
  isSelf: boolean
}

export async function listAccessRoles(): Promise<ApiResult<AdminRoleSummary[]>> {
  return request<AdminRoleSummary[]>('/api/v1/admin/access/roles', { method: 'GET' })
}

export async function listStaff(): Promise<ApiResult<StaffMember[]>> {
  return request<StaffMember[]>('/api/v1/admin/access/staff', { method: 'GET' })
}

// ---------------------------------------------------------------------------
// Financial reporting
// ---------------------------------------------------------------------------

export interface SignedMoney {
  amount: string
  currency: 'IRR'
}

export interface FinancialReport {
  range: { from: string; to: string }
  trialBalance: {
    asOf: string
    rows: Array<{
      accountCode: string
      accountName: string
      accountType: string
      debits: Money
      credits: Money
      balance: SignedMoney
      entryCount: number
    }>
    totalDebits: Money
    totalCredits: Money
    balanced: boolean
  }
  settlement: {
    capturedValue: Money
    capturedCount: number
    paidOrders: number
    paidOrderValue: Money
    captureToOrderGap: SignedMoney
    paymentsByState: Record<string, number>
    receipts: {
      total: number
      awaitingProcessing: number
      processed: number
      rejected: number
      oldestAwaitingAt: string | null
    }
  }
  providers: Array<{
    providerCode: string
    environment: string
    attempts: number
    verified: number
    rejected: number
    failed: number
    inFlight: number
    verificationRate: number | null
  }>
}

export async function readFinancialReport(
  from: string,
  to: string,
): Promise<ApiResult<FinancialReport>> {
  const query = new URLSearchParams({ from, to })
  return request<FinancialReport>(`/api/v1/admin/reports/financial?${query.toString()}`, {
    method: 'GET',
  })
}

// ---------------------------------------------------------------------------
// Order operations
// ---------------------------------------------------------------------------

export interface OrderOperationOutcome {
  orderId: string
  publicId: string
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
  updatedAt: string
}
