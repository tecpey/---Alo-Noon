import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import { callbackIdempotencyKey } from './modules/payment-callback'
import type { PaymentProviderService } from './modules/payment-provider'

const tenantId = '00000000-0000-4000-8000-000000000001'
const resultRedirectUrl = 'https://app.alonoon.ir/payments/result'

function authFixture(resolvesTenant = true): AuthDependencies {
  return {
    repository: {
      resolveTenantByHost: async () => (resolvesTenant ? tenantId : null),
      findSession: async () => null as SessionContext | null,
    } as unknown as AuthRepository,
    deliveryService: { request: async () => Promise.reject(new Error('unused')) },
    otpPepper: 'callback-otp-pepper',
    abusePepper: 'callback-abuse-pepper',
    sessionPepper: 'callback-session-pepper',
    secureCookie: false,
  }
}

function providerServiceFixture(receiveCallback = vi.fn().mockResolvedValue({})) {
  return {
    service: { receiveCallback } as unknown as PaymentProviderService,
    receiveCallback,
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

async function callbackApp(options: { auth?: AuthDependencies; service?: PaymentProviderService }) {
  const app = await buildApp({
    auth: options.auth ?? authFixture(),
    paymentCallback: {
      providerService: options.service ?? providerServiceFixture().service,
      resultRedirectUrl,
      environment: 'TEST',
    },
  })
  apps.push(app)
  return app
}

describe('payment callback route', () => {
  it('records the callback and redirects without revealing any payment verdict', async () => {
    const { service, receiveCallback } = providerServiceFixture()
    const app = await callbackApp({ service })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/callback/idpay?id=tx-abc&order_id=attempt-1&status=100',
    })

    expect(response.statusCode).toBe(303)
    const location = new URL(response.headers['location'] as string)
    expect(location.origin + location.pathname).toBe(resultRedirectUrl)
    expect(location.searchParams.get('reference')).toBe('tx-abc')
    // The provider's own claim of success must not reach the customer here.
    expect(location.searchParams.get('status')).toBeNull()
    expect(response.headers['cache-control']).toBe('no-store')

    expect(receiveCallback).toHaveBeenCalledTimes(1)
    const [calledTenantId, command] = receiveCallback.mock.calls[0] as [
      string,
      {
        providerCode: string
        externalEventId: string
        approvedHeaders: unknown
        idempotencyKey: string
      },
    ]
    expect(calledTenantId).toBe(tenantId)
    expect(command.providerCode).toBe('IDPAY')
    expect(command.externalEventId).toBe('tx-abc')
    expect(command.approvedHeaders).toEqual({})
    expect(command.idempotencyKey).toBe(callbackIdempotencyKey('IDPAY', 'tx-abc'))
  })

  it('accepts a POST callback body, as gateways redirect with either method', async () => {
    const { service, receiveCallback } = providerServiceFixture()
    const app = await callbackApp({ service })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/callback/nextpay',
      payload: { trans_id: 'trans-xyz', order_id: 'attempt-9' },
    })

    expect(response.statusCode).toBe(303)
    expect(receiveCallback).toHaveBeenCalledTimes(1)
    const [, command] = receiveCallback.mock.calls[0] as [string, { externalEventId: string }]
    expect(command.externalEventId).toBe('trans-xyz')
  })

  it('replays onto one receipt when the customer refreshes the return page', async () => {
    const { service, receiveCallback } = providerServiceFixture()
    const app = await callbackApp({ service })

    const request = {
      method: 'GET' as const,
      url: '/api/v1/payments/callback/shepa?token=tok-1&status=success',
    }
    await app.inject(request)
    await app.inject(request)

    expect(receiveCallback).toHaveBeenCalledTimes(2)
    const keyOf = (index: number) =>
      (receiveCallback.mock.calls[index] as [string, { idempotencyKey: string }])[1].idempotencyKey
    expect(keyOf(0)).toBe(keyOf(1))
  })

  it('still redirects the customer when recording the callback fails', async () => {
    const receiveCallback = vi.fn().mockRejectedValue(new Error('CALLBACK_REPLAY_CONFLICT'))
    const app = await callbackApp({ service: providerServiceFixture(receiveCallback).service })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/callback/idpay?id=tx-abc',
    })

    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toContain('reference=tx-abc')
  })

  it.each([
    ['an unknown provider', '/api/v1/payments/callback/unknownpsp?id=tx-abc'],
    ['a missing provider reference', '/api/v1/payments/callback/idpay?status=100'],
  ])('records nothing for %s but still returns the customer safely', async (_label, url) => {
    const { service, receiveCallback } = providerServiceFixture()
    const app = await callbackApp({ service })

    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).not.toContain('reference=')
    expect(receiveCallback).not.toHaveBeenCalled()
  })

  it('records nothing when the host does not resolve to a tenant', async () => {
    const { service, receiveCallback } = providerServiceFixture()
    const app = await callbackApp({ auth: authFixture(false), service })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/callback/idpay?id=tx-abc',
    })

    expect(response.statusCode).toBe(303)
    expect(receiveCallback).not.toHaveBeenCalled()
  })

  it('is not registered at all when no result redirect is configured', async () => {
    const app = await buildApp({ auth: authFixture() })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/callback/idpay?id=tx-abc',
    })

    expect(response.statusCode).toBe(404)
  })
})
