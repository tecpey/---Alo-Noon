import { describe, expect, it, vi } from 'vitest'

import { createCourierApiClient, CourierApiError, type CourierFetch } from './api'

const meta = {
  requestId: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-08-08T09:00:00.000Z',
  version: 'v1',
} as const

const task = {
  taskId: '55555555-5555-4555-8555-555555555555',
  orderId: '66666666-6666-4666-8666-666666666666',
  orderPublicId: 'A7K2M9',
  state: 'ASSIGNED',
  attemptCount: 0,
  recipientName: 'زهرا محمدی',
  recipientPhone: '+989120000000',
  address: 'بابل، خیابان نان',
  bakeryName: 'نان سنگک بابل',
  totalAmount: '250000',
  deliverBefore: null,
  courier: null,
  updatedAt: '2026-08-08T09:00:00.000Z',
} as const

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

describe('courier API client', () => {
  it('carries the session as a cookie and never as a bearer token', async () => {
    const fetchMock = vi
      .fn<CourierFetch>()
      .mockResolvedValue(jsonResponse({ success: true, data: [task], meta }))
    const client = createCourierApiClient('https://api.alonoon.ir/', fetchMock)

    await client.listDeliveries()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.alonoon.ir/api/v1/courier/deliveries',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('reads an unauthorized session check as signed out rather than as a failure', async () => {
    const fetchMock = vi.fn<CourierFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'SESSION_UNAUTHORIZED', message: 'A valid session is required.' },
          meta,
        },
        401,
      ),
    )
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.getSession()).resolves.toBeNull()
  })

  it('surfaces "this is not your app" as itself, not as a sign-in failure', async () => {
    // The session is valid; the account simply is not on the courier roster.
    // Collapsing this into a 401 would send someone to sign in again forever.
    const fetchMock = vi.fn<CourierFetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'NOT_A_COURIER', message: 'This account is not a courier.' },
          meta,
        },
        403,
      ),
    )
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.listDeliveries()).rejects.toMatchObject({
      code: 'NOT_A_COURIER',
      status: 403,
    })
  })

  it('sends a failure reason only when there is one', async () => {
    // A fresh Response per call: a body can only be read once, and this test
    // makes two requests.
    const fetchMock = vi
      .fn<CourierFetch>()
      .mockImplementation(async () => jsonResponse({ success: true, data: task, meta }))
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await client.report(task.taskId, 'DELIVERED')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ to: 'DELIVERED' })

    await client.report(task.taskId, 'FAILED', 'NOBODY_HOME')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      to: 'FAILED',
      reasonCode: 'NOBODY_HOME',
    })
  })

  it('escapes a task id rather than pasting it into a path', async () => {
    const fetchMock = vi
      .fn<CourierFetch>()
      .mockResolvedValue(jsonResponse({ success: true, data: task, meta }))
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await client.respond('../../admin/orders', true)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.alonoon.ir/api/v1/courier/deliveries/..%2F..%2Fadmin%2Forders/respond',
    )
  })

  it('refuses a response whose shape it does not recognise', async () => {
    // Acting on a half-understood payload would be a courier told an order is
    // theirs when it is not.
    const fetchMock = vi
      .fn<CourierFetch>()
      .mockResolvedValue(jsonResponse({ success: true, data: [{ taskId: 'nope' }], meta }))
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.listDeliveries()).rejects.toBeInstanceOf(CourierApiError)
  })

  it('keeps the retry-after a rate limit gave it', async () => {
    const fetchMock = vi
      .fn<CourierFetch>()
      .mockResolvedValue(
        jsonResponse(
          { success: false, error: { code: 'RATE_LIMITED', message: 'Too many.' }, meta },
          429,
          { 'Retry-After': '30' },
        ),
      )
    const client = createCourierApiClient('https://api.alonoon.ir', fetchMock)

    await expect(client.listDeliveries()).rejects.toMatchObject({ retryAfterSeconds: 30 })
  })

  it('refuses a base URL that could send a session somewhere else', async () => {
    for (const bad of ['ftp://api.alonoon.ir', 'https://api.alonoon.ir/v1', 'https://a:b@x.ir']) {
      expect(() => createCourierApiClient(bad)).toThrow()
    }
  })
})
