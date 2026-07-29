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

  it('preserves bounded retry information from API errors', async () => {
    const fetchMock = vi.fn<CustomerFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'OTP_COOLDOWN_ACTIVE', message: 'Wait.' },
          meta,
        },
        429,
        { 'Retry-After': '42' },
      ),
    )
    const client = createCustomerApiClient('https://api.alonoon.ir', fetchMock)

    const error = await client.requestOtp('+989111234567').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CustomerApiError)
    expect(error).toMatchObject({ code: 'OTP_COOLDOWN_ACTIVE', retryAfterSeconds: 42 })
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
          expiresAt: '2026-07-29T12:10:00.000Z',
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

    await expect(client.createQuote(3, 'mobile-quote-command-0001')).resolves.toMatchObject({
      cartVersion: 3,
      total: { amount: '500000' },
    })
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedCartVersion: 3, idempotencyKey: 'mobile-quote-command-0001' }),
    )
  })
})
