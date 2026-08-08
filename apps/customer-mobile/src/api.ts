import {
  activeCitiesEnvelopeSchema,
  addressEnvelopeSchema,
  addressesEnvelopeSchema,
  cartEnvelopeSchema,
  catalogPageSchema,
  errorEnvelopeSchema,
  otpRequestEnvelopeSchema,
  quoteEnvelopeSchema,
  orderEnvelopeSchema,
  paymentEnvelopeSchema,
  paymentExecutionEnvelopeSchema,
  serviceabilityEnvelopeSchema,
  sessionEnvelopeSchema,
  type ActiveCitySummary,
  type AddressCreate,
  type AddressSummary,
  type CartSummary,
  type OtpRequestAccepted,
  type ProductSummary,
  type QuoteSummary,
  type OrderSummary,
  type PaymentExecutionSummary,
  type PaymentSummary,
  type ServiceabilityResponse,
  type SessionContext,
} from '@alo-noon/contracts'

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export type CustomerFetch = (input: string, init?: RequestInit) => Promise<Response>

export class CustomerApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code)
  }
}

export interface CustomerApiClient {
  getSession(): Promise<SessionContext | null>
  requestOtp(mobileE164: string, idempotencyKey: string): Promise<OtpRequestAccepted>
  verifyOtp(challengeId: string, code: string): Promise<SessionContext>
  logout(): Promise<void>
  listActiveCities(): Promise<ActiveCitySummary[]>
  checkServiceability(input: {
    cityId: string
    latitude: number
    longitude: number
  }): Promise<ServiceabilityResponse>
  listCatalog(input: { cityId: string; operationalZoneId: string }): Promise<ProductSummary[]>
  getCart(): Promise<CartSummary | null>
  listAddresses(): Promise<AddressSummary[]>
  createAddress(input: AddressCreate): Promise<AddressSummary>
  setCartItem(
    offeringId: string,
    input: {
      cityId: string
      operationalZoneId: string
      quantity: number
      expectedCartVersion?: number
    },
  ): Promise<CartSummary>
  removeCartItem(offeringId: string, expectedCartVersion?: number): Promise<CartSummary>
  createQuote(
    deliveryAddressId: string,
    expectedCartVersion: number,
    idempotencyKey: string,
  ): Promise<QuoteSummary>
  createOrder(quoteId: string, idempotencyKey: string): Promise<OrderSummary>
  /**
   * Opens the payment for a placed order. The amount is never sent — it comes
   * from the order's own total, because a client-supplied amount would be a
   * client-chosen price.
   */
  startPayment(orderId: string, idempotencyKey: string): Promise<PaymentSummary>
  /**
   * Asks the gateway for a page to send the customer to. `customerAction.url`
   * is where they go; a result without one means the gateway refused before the
   * customer ever saw it.
   */
  initializePayment(paymentId: string, idempotencyKey: string): Promise<PaymentExecutionSummary>
  /**
   * Reads a payment back after the customer returns from the gateway.
   *
   * The return redirect proves nothing — every parameter on it is
   * attacker-controllable, and settlement decides from the gateway's own
   * server-to-server answer — so the screen asks the API what happened rather
   * than believing the URL it landed on.
   */
  readPayment(paymentId: string): Promise<PaymentSummary>
}

export function createCustomerApiClient(
  baseUrl: string,
  fetchImplementation: CustomerFetch = fetch,
): CustomerApiClient {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  const request = async <T>(
    path: string,
    schema: RuntimeSchema<{ data: T }>,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) throw await apiError(response)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new CustomerApiError('INVALID_API_RESPONSE', response.status)
    return parsed.data.data
  }

  return {
    async getSession() {
      try {
        return await request('/api/v1/auth/session', sessionEnvelopeSchema)
      } catch (error) {
        if (error instanceof CustomerApiError && error.status === 401) return null
        throw error
      }
    },
    requestOtp: async (mobileE164, idempotencyKey) =>
      request('/api/v1/auth/otp/request', otpRequestEnvelopeSchema, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ mobileE164 }),
      }),
    verifyOtp: async (challengeId, code) =>
      request('/api/v1/auth/otp/verify', sessionEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ challengeId, code }),
      }),
    async logout() {
      const response = await fetchImplementation(`${normalizedBaseUrl}/api/v1/auth/session`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok && response.status !== 204) throw await apiError(response)
    },
    listActiveCities: async () => {
      const envelope = await request('/api/v1/serviceability/cities', activeCitiesEnvelopeSchema)
      return envelope
    },
    checkServiceability: async (input) =>
      request('/api/v1/serviceability/check', serviceabilityEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listCatalog: async ({ cityId, operationalZoneId }) => {
      const query = new URLSearchParams({
        cityId,
        operationalZoneId,
        page: '1',
        pageSize: '50',
      })
      return request(`/api/v1/catalog/products?${query.toString()}`, catalogPageSchema)
    },
    getCart: async () => request('/api/v1/cart', cartEnvelopeSchema),
    listAddresses: async () => request('/api/v1/addresses', addressesEnvelopeSchema),
    createAddress: async (input) =>
      request('/api/v1/addresses', addressEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    setCartItem: async (offeringId, input) =>
      request(`/api/v1/cart/items/${encodeURIComponent(offeringId)}`, cartEnvelopeSchema, {
        method: 'PUT',
        body: JSON.stringify(input),
      }).then(requireCart),
    removeCartItem: async (offeringId, expectedCartVersion) =>
      request(`/api/v1/cart/items/${encodeURIComponent(offeringId)}`, cartEnvelopeSchema, {
        method: 'DELETE',
        body: JSON.stringify({
          ...(expectedCartVersion !== undefined && { expectedCartVersion }),
        }),
      }).then(requireCart),
    createQuote: async (deliveryAddressId, expectedCartVersion, idempotencyKey) =>
      request('/api/v1/cart/quote', quoteEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ deliveryAddressId, expectedCartVersion, idempotencyKey }),
      }),
    createOrder: async (quoteId, idempotencyKey) =>
      request('/api/v1/orders', orderEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ quoteId, idempotencyKey }),
      }),
    startPayment: async (orderId, idempotencyKey) =>
      request('/api/v1/payments', paymentEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ orderId, idempotencyKey }),
      }),
    initializePayment: async (paymentId, idempotencyKey) =>
      request('/api/v1/payments/initialize', paymentExecutionEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ paymentId, idempotencyKey }),
      }),
    readPayment: async (paymentId) =>
      request(`/api/v1/payments/${encodeURIComponent(paymentId)}`, paymentEnvelopeSchema),
  }
}

function requireCart(cart: CartSummary | null): CartSummary {
  if (!cart) throw new CustomerApiError('INVALID_API_RESPONSE', 200)
  return cart
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must use HTTP or HTTPS')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must not include a path')
  }
  return url.origin
}

async function apiError(response: Response): Promise<CustomerApiError> {
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined

  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    if (parsed.success) {
      return new CustomerApiError(
        parsed.data.error.code,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      )
    }
  } catch {
    // Fall through to the bounded transport error below.
  }

  return new CustomerApiError(
    response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_FAILED',
    response.status,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  )
}
