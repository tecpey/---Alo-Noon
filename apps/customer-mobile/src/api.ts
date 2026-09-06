import {
  activeCitiesEnvelopeSchema,
  addressEnvelopeSchema,
  addressesEnvelopeSchema,
  cartEnvelopeSchema,
  catalogPageSchema,
  deliveryWindowListEnvelopeSchema,
  errorEnvelopeSchema,
  otpRequestEnvelopeSchema,
  quoteEnvelopeSchema,
  orderEnvelopeSchema,
  orderListEnvelopeSchema,
  reorderEnvelopeSchema,
  paymentEnvelopeSchema,
  paymentExecutionEnvelopeSchema,
  pushDeviceEnvelopeSchema,
  serviceabilityEnvelopeSchema,
  sessionEnvelopeSchema,
  walletEntryListEnvelopeSchema,
  walletEnvelopeSchema,
  walletTopUpStartedEnvelopeSchema,
  walletTransferEnvelopeSchema,
  walletTransferListEnvelopeSchema,
  type ActiveCitySummary,
  type AddressCreate,
  type AddressSummary,
  type CartSummary,
  type DeliveryWindow,
  type OtpRequestAccepted,
  type PaymentMethod,
  type ProductSummary,
  type QuoteSummary,
  type OrderSummary,
  type ReorderResult,
  type PaymentExecutionSummary,
  type PaymentSummary,
  type PushDeviceRegister,
  type PushDeviceSummary,
  type ServiceabilityResponse,
  type SessionContext,
  type WalletEntrySummary,
  type WalletSummary,
  type WalletTransferSummary,
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
    /**
     * What the refusal knows beyond its code.
     *
     * A balance short by exactly this much is the amount to top up, and the
     * attempts left on a transfer code is a number a customer needs to see.
     * Carried as `unknown` because the shape belongs to the code beside it.
     */
    readonly details?: unknown,
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
  /**
   * The delivery windows this basket's branch is offering.
   *
   * Empty is a normal answer, not a failure: a branch with no recorded hours
   * offers no windows, and its orders go out as soon as they are ready — which
   * is what every order did before windows existed.
   */
  listDeliveryWindows(): Promise<DeliveryWindow[]>
  /**
   * Prices the basket for one address.
   *
   * The three optional choices are requests, not decisions. A quote never fails
   * because of them — a code that does not apply, a window that has filled, or
   * cash where cash is not offered each come back as a refusal on an otherwise
   * good quote. A basket that will not price is a basket that gets abandoned.
   */
  createQuote(
    deliveryAddressId: string,
    expectedCartVersion: number,
    idempotencyKey: string,
    choices?: {
      promotionCode?: string
      deliveryWindowStartsAt?: string
      paymentMethod?: PaymentMethod
    },
  ): Promise<QuoteSummary>
  createOrder(quoteId: string, idempotencyKey: string): Promise<OrderSummary>
  /**
   * Opens the payment for a placed order. The amount is never sent — it comes
   * from the order's own total, because a client-supplied amount would be a
   * client-chosen price.
   */
  startPayment(
    orderId: string,
    idempotencyKey: string,
    /** Which of the customer's own money pays. Omitted means the gateway. */
    source?: 'GATEWAY' | 'BALANCE',
  ): Promise<PaymentSummary>
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
  /**
   * The customer's own recent orders, newest first. Drafts are excluded by the
   * API — an abandoned checkout is not an order anyone placed.
   */
  listOrders(): Promise<OrderSummary[]>
  /** One order, for following it after payment. */
  readOrder(orderId: string): Promise<OrderSummary>
  /**
   * Rebuilds the basket from a past order, at today's prices.
   *
   * The adjustments are the half that matters: a customer who taps "order
   * again" and quietly receives two loaves instead of four has been let down
   * twice — once by the bakery, and once by the app that did not mention it.
   */
  reorder(orderId: string): Promise<ReorderResult>
  /**
   * Tells the server which handset to reach this customer on.
   *
   * Idempotent by token: the app calls it on every sign-in and every cold
   * start, and the right answer to "this token again" is to move the row's
   * clock forward rather than accumulate a row per launch.
   */
  registerPushDevice(input: PushDeviceRegister): Promise<PushDeviceSummary>
  /** On sign-out, so the next order does not buzz a phone nobody is signed into. */
  forgetPushDevice(expoPushToken: string): Promise<void>

  /* ---------------------------------------------------------------- wallet */

  /** The balance, opening an empty wallet the first time it is asked for. */
  readWallet(): Promise<WalletSummary>
  /** The statement, newest first. */
  listWalletEntries(): Promise<WalletEntrySummary[]>
  /**
   * Opens a payment that will charge the balance.
   *
   * Answers with a payment id, which is then initialised and redirected to
   * exactly like an order's — a top-up is an ordinary payment, and that is what
   * buys it the callback route and the recovery sweep for free.
   */
  startWalletTopUp(amountRial: string, idempotencyKey: string): Promise<{ paymentId: string }>
  /** Transfers this customer started, newest first. */
  listWalletTransfers(): Promise<WalletTransferSummary[]>
  /**
   * Names a recipient and an amount, and asks for a code. Moves no money.
   */
  openWalletTransfer(input: {
    recipientMobile: string
    amountRial: string
    idempotencyKey: string
  }): Promise<WalletTransferSummary>
  /** Types the code back. This is the call that moves the money. */
  confirmWalletTransfer(transferId: string, code: string): Promise<WalletTransferSummary>
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
    listDeliveryWindows: async () =>
      request('/api/v1/cart/delivery-windows', deliveryWindowListEnvelopeSchema),
    createQuote: async (deliveryAddressId, expectedCartVersion, idempotencyKey, choices = {}) =>
      request('/api/v1/cart/quote', quoteEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({
          deliveryAddressId,
          expectedCartVersion,
          idempotencyKey,
          // Spread rather than sent as undefined: the quote schema rejects an
          // explicit null, and an empty code field must read as "no code" and
          // not as "this code is blank".
          ...(choices.promotionCode && { promotionCode: choices.promotionCode }),
          ...(choices.deliveryWindowStartsAt && {
            deliveryWindowStartsAt: choices.deliveryWindowStartsAt,
          }),
          ...(choices.paymentMethod && { paymentMethod: choices.paymentMethod }),
        }),
      }),
    createOrder: async (quoteId, idempotencyKey) =>
      request('/api/v1/orders', orderEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ quoteId, idempotencyKey }),
      }),
    startPayment: async (orderId, idempotencyKey, source) =>
      request('/api/v1/payments', paymentEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ orderId, idempotencyKey, ...(source && { source }) }),
      }),
    initializePayment: async (paymentId, idempotencyKey) =>
      request('/api/v1/payments/initialize', paymentExecutionEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ paymentId, idempotencyKey }),
      }),
    readPayment: async (paymentId) =>
      request(`/api/v1/payments/${encodeURIComponent(paymentId)}`, paymentEnvelopeSchema),
    readWallet: async () => request('/api/v1/wallet', walletEnvelopeSchema),
    listWalletEntries: async () => request('/api/v1/wallet/entries', walletEntryListEnvelopeSchema),
    startWalletTopUp: async (amountRial, idempotencyKey) =>
      request('/api/v1/wallet/top-ups', walletTopUpStartedEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({ amount: amountRial, idempotencyKey }),
      }),
    listWalletTransfers: async () =>
      request('/api/v1/wallet/transfers', walletTransferListEnvelopeSchema),
    openWalletTransfer: async (input) =>
      request('/api/v1/wallet/transfers', walletTransferEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify({
          recipientMobile: input.recipientMobile,
          amount: input.amountRial,
          idempotencyKey: input.idempotencyKey,
        }),
      }),
    confirmWalletTransfer: async (transferId, code) =>
      request(
        `/api/v1/wallet/transfers/${encodeURIComponent(transferId)}/confirm`,
        walletTransferEnvelopeSchema,
        { method: 'POST', body: JSON.stringify({ code }) },
      ),
    listOrders: async () => request('/api/v1/orders', orderListEnvelopeSchema),
    readOrder: async (orderId) =>
      request(`/api/v1/orders/${encodeURIComponent(orderId)}`, orderEnvelopeSchema),
    reorder: async (orderId) =>
      request(`/api/v1/orders/${encodeURIComponent(orderId)}/reorder`, reorderEnvelopeSchema, {
        method: 'POST',
      }),
    registerPushDevice: async (input) =>
      request('/api/v1/push/devices', pushDeviceEnvelopeSchema, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    async forgetPushDevice(expoPushToken) {
      const response = await fetchImplementation(`${normalizedBaseUrl}/api/v1/push/devices`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ expoPushToken }),
      })
      if (!response.ok && response.status !== 204) throw await apiError(response)
    },
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
        parsed.data.error.details,
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
