import { describe, expect, it, vi } from 'vitest'

import { createCustomerApiClient, CustomerApiError, type CustomerFetch } from './api'

const meta = {
  requestId: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-07-29T12:00:00.000Z',
  version: 'v1',
} as const

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

describe('customer API client', () => {
  it('uses credentialed cookie requests without exposing an authorization token', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          tenantId: '00000000-0000-4000-8000-000000000001',
          accountId: '22222222-2222-4222-8222-222222222222',
          customerId: '33333333-3333-4333-8333-333333333333',
          expiresAt: '2026-08-29T12:00:00.000Z',
          grants: [],
        },
        meta,
      }),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir/', fetchMock)

    await client.verifyOtp('44444444-4444-4444-8444-444444444444', '004231')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.alonoon.ir/api/v1/auth/otp/verify',
      expect.objectContaining({ credentials: 'include' }),
    )
    const request = fetchMock.mock.calls[0]?.[1]
    expect(request?.headers).not.toHaveProperty('Authorization')
    expect(request?.body).not.toContain('opaque-session-token')
  })

  it('treats an unauthorized session check as a signed-out state', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'SESSION_UNAUTHORIZED', message: 'A valid session is required.' },
          meta,
        },
        401,
      ),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.getSession()).resolves.toBeNull()
  })

  it('rejects malformed success responses instead of trusting transport JSON', async () => {
    const fetchMock = vi
      .fn<CustomerFetch>()
      .mockResolvedValue(jsonResponse({ success: true, data: [{ id: 'not-a-uuid' }], meta }))
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.listActiveCities()).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
    })
  })

  it('sends a stable OTP idempotency key without exposing authority fields', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'OTP_DELIVERY_UNAVAILABLE', message: 'Unavailable.' },
          meta,
        },
        503,
      ),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    const error = await client
      .requestOtp('+989111234567', 'otp-test-idempotency-key')
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CustomerApiError)
    expect(error).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE', status: 503 })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': 'otp-test-idempotency-key',
    })
  })

  it('rejects unsafe or ambiguous API base URLs before making a request', () => {
    expect(() => createCustomerApiClient('file:///tmp/api')).toThrow()
    expect(() => createCustomerApiClient('https://user:secret@api.alonoon.ir')).toThrow()
    expect(() => createCustomerApiClient('https://api.alonoon.ir/v1')).toThrow('path')
    expect(() => createCustomerApiClient('https://api.alonoon.ir?tenant=other')).toThrow()
  })

  it('fails closed when server-side logout cannot be confirmed', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable.' },
          meta,
        },
        503,
      ),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.logout()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.alonoon.ir/api/v1/auth/session',
      expect.objectContaining({ credentials: 'include', method: 'DELETE' }),
    )
  })

  it('uses authenticated server cart endpoints without sending a client price', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          cityId: '22222222-2222-4222-8222-222222222222',
          operationalZoneId: '33333333-3333-4333-8333-333333333333',
          bakeryBranchId: '44444444-4444-4444-8444-444444444444',
          version: 1,
          subtotal: { amount: '250000', currency: 'IRR' },
          items: [],
          updatedAt: meta.timestamp,
        },
        meta,
      }),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await client.setCartItem('55555555-5555-4555-8555-555555555555', {
      cityId: '22222222-2222-4222-8222-222222222222',
      operationalZoneId: '33333333-3333-4333-8333-333333333333',
      quantity: 1,
    })

    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(
      'https://api.alonoon.ir/api/v1/cart/items/55555555-5555-4555-8555-555555555555',
    )
    expect(call?.[1]).toMatchObject({ method: 'PUT', credentials: 'include' })
    expect(call?.[1]?.body).not.toContain('price')
    expect(call?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('validates immutable quote responses and keeps idempotency in the command body', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          publicId: 'quote-public-001',
          cartId: '22222222-2222-4222-8222-222222222222',
          cartVersion: 3,
          status: 'ACTIVE',
          paymentMethod: 'ONLINE_GATEWAY',
          rating: null,
          expiresAt: '2026-07-29T12:10:00.000Z',
          deliveryAddressId: '77777777-7777-4777-8777-777777777777',
          deliveryServiceAreaId: '88888888-8888-4888-8888-888888888888',
          deliveryOperationalZoneId: '99999999-9999-4999-8999-999999999999',
          deliveryDistanceMeters: 1250,
          deliveryPricingRuleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          deliveryPricingRuleVersion: 2,
          subtotal: { amount: '500000', currency: 'IRR' },
          deliveryFee: { amount: '0', currency: 'IRR' },
          discount: { amount: '0', currency: 'IRR' },
          total: { amount: '500000', currency: 'IRR' },
          items: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              bakeryProductOfferingId: '44444444-4444-4444-8444-444444444444',
              productVariantId: '55555555-5555-4555-8555-555555555555',
              bakeryBranchId: '66666666-6666-4666-8666-666666666666',
              sku: 'ALO-SIGNATURE-001',
              nameFa: 'بربری ویژه',
              fulfillmentClass: 'SIGNATURE_FRESH',
              freshnessClaim: 'FRESHLY_PRODUCED',
              quantity: 2,
              unitPrice: { amount: '250000', currency: 'IRR' },
              lineTotal: { amount: '500000', currency: 'IRR' },
            },
          ],
          createdAt: meta.timestamp,
        },
        meta,
      }),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(
      client.createQuote('77777777-7777-4777-8777-777777777777', 3, 'mobile-quote-command-0001'),
    ).resolves.toMatchObject({
      cartVersion: 3,
      total: { amount: '500000' },
    })
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        deliveryAddressId: '77777777-7777-4777-8777-777777777777',
        expectedCartVersion: 3,
        idempotencyKey: 'mobile-quote-command-0001',
      }),
    )
  })

  /**
   * The three checkout choices reach the wire, and an unused one stays off it.
   *
   * The failure this guards against is quiet: a blank code field sent as
   * `promotionCode: ''` is refused by the quote schema, so a customer who
   * never touched the discount box cannot get a price at all. Nothing about
   * the screen would say why.
   */
  it('carries the checkout choices, and omits the ones not made', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(jsonResponse({}, 500))
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(
      client.createQuote('77777777-7777-4777-8777-777777777777', 3, 'mobile-quote-command-0001', {
        promotionCode: 'NOON10',
      }),
    ).rejects.toBeInstanceOf(CustomerApiError)

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ promotionCode: 'NOON10' })
    expect(body).not.toHaveProperty('deliveryWindowStartsAt')
  })

  it('drops an empty discount code rather than sending a blank one', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(jsonResponse({}, 500))
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    await expect(
      client.createQuote('77777777-7777-4777-8777-777777777777', 3, 'mobile-quote-command-0001', {
        promotionCode: '',
      }),
    ).rejects.toBeInstanceOf(CustomerApiError)

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      'promotionCode',
    )
  })

  it('sends only quote identity and an idempotency key when creating an order', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          publicId: 'order-public-001',
          quoteId: '22222222-2222-4222-8222-222222222222',
          state: 'PENDING_CONFIRMATION',
          paymentState: 'NOT_STARTED',
          paymentMethod: 'ONLINE_GATEWAY',
          rating: null,
          productionState: 'UNSCHEDULED',
          deliveryState: 'UNASSIGNED',
          subtotal: { amount: '500000', currency: 'IRR' },
          deliveryFee: { amount: '50000', currency: 'IRR' },
          discount: { amount: '0', currency: 'IRR' },
          total: { amount: '550000', currency: 'IRR' },
          items: [],
          createdAt: meta.timestamp,
          updatedAt: meta.timestamp,
        },
        meta,
      }),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)
    await client.createOrder('22222222-2222-4222-8222-222222222222', 'mobile-order-command-0001')
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        quoteId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: 'mobile-order-command-0001',
      }),
    )
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain('total')
  })

  it('never sends an amount when opening a payment', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: true,
          data: {
            id: '55555555-5555-4555-8555-555555555555',
            publicId: 'PAY-000001',
            orderId: '66666666-6666-4666-8666-666666666666',
            customerId: '33333333-3333-4333-8333-333333333333',
            state: 'CREATED',
            amount: { amount: '250000', currency: 'IRR' },
            version: 1,
            createdAt: '2026-08-08T09:00:00.000Z',
            updatedAt: '2026-08-08T09:00:00.000Z',
          },
          meta,
        },
        201,
      ),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    const payment = await client.startPayment(
      '66666666-6666-4666-8666-666666666666',
      'mobile-payment-0000000001',
    )

    expect(payment.amount.amount).toBe('250000')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    // The amount comes from the order on the server. A client that could name a
    // price would be a client that could choose one.
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'orderId'])
  })

  it('surfaces the gateway page to open, and refuses a response without one', async () => {
    const accepted = {
      paymentAttemptId: '77777777-7777-4777-8777-777777777777',
      paymentId: '55555555-5555-4555-8555-555555555555',
      providerConfigurationId: '88888888-8888-4888-8888-888888888888',
      providerCode: 'IDPAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      state: 'CUSTOMER_ACTION_REQUIRED',
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'tx-1',
      customerAction: { url: 'https://gateway.example/pay/tx-1', expiresAt: null },
      failure: null,
      correlationId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
      createdAt: '2026-08-08T09:00:00.000Z',
      updatedAt: '2026-08-08T09:00:00.000Z',
    }
    const fetchMock = vi
      .fn<CustomerFetch>()
      .mockResolvedValue(jsonResponse({ success: true, data: accepted, meta }, 201))
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)
    const result = await client.initializePayment(
      '55555555-5555-4555-8555-555555555555',
      'mobile-payment-0000000001',
    )
    expect(result.customerAction?.url).toBe('https://gateway.example/pay/tx-1')

    // An http:// action would send a customer to a page their bank credentials
    // travel to in the clear; the contract refuses it before the app can open it.
    const insecure = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: true,
          data: {
            ...accepted,
            customerAction: { url: 'http://gateway.example/pay', expiresAt: null },
          },
          meta,
        },
        201,
      ),
    )
    await expect(
      createCustomerApiClient('https://api.alonoon.ir', insecure).initializePayment(
        '55555555-5555-4555-8555-555555555555',
        'mobile-payment-0000000001',
      ),
    ).rejects.toBeInstanceOf(CustomerApiError)
  })

  it('reads a payment back by id rather than trusting the return URL', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: '55555555-5555-4555-8555-555555555555',
          publicId: 'PAY-000001',
          orderId: '66666666-6666-4666-8666-666666666666',
          customerId: '33333333-3333-4333-8333-333333333333',
          state: 'CAPTURED',
          amount: { amount: '250000', currency: 'IRR' },
          version: 4,
          createdAt: '2026-08-08T09:00:00.000Z',
          updatedAt: '2026-08-08T09:05:00.000Z',
        },
        meta,
      }),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)
    const payment = await client.readPayment('55555555-5555-4555-8555-555555555555')

    expect(payment.state).toBe('CAPTURED')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.alonoon.ir/api/v1/payments/55555555-5555-4555-8555-555555555555',
    )
  })
})
