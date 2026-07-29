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
})
