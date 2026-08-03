import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { PaymentExecutionSummary, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import {
  isRetryablePaymentExecutionConflict,
  paymentExecutionRequestKey,
  type PaymentExecutionService,
} from './modules/payment-execution'

const tenantId = '00000000-0000-4000-8000-000000000001'
const customerId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const paymentId = '33333333-3333-4333-8333-333333333333'
const attemptId = '44444444-4444-4444-8444-444444444444'
const configurationId = '55555555-5555-4555-8555-555555555555'
const correlationId = '66666666-6666-4666-8666-666666666666'
const token = 'payment-execution-session-token'
const sessionPepper = 'payment-execution-session-pepper'

const summary: PaymentExecutionSummary = {
  paymentAttemptId: attemptId,
  paymentId,
  providerConfigurationId: configurationId,
  providerCode: 'TEST_GATEWAY',
  adapterVersion: '1.0.0',
  adapterSpiVersion: 1,
  state: 'INITIALIZED',
  outcome: 'ACCEPTED',
  providerReference: 'provider-reference',
  customerAction: null,
  failure: null,
  correlationId,
  replayed: false,
  createdAt: '2026-08-04T09:00:00.000Z',
  updatedAt: '2026-08-04T09:00:01.000Z',
}

function authFixture(): AuthDependencies {
  const context: SessionContext = {
    tenantId,
    accountId,
    customerId,
    expiresAt: '2026-09-04T09:00:00.000Z',
    grants: [],
  }
  const digest = createHmac('sha256', sessionPepper).update(token).digest('hex')
  return {
    repository: {
      resolveTenantByHost: async () => tenantId,
      findSession: async (value: string) => (value === digest ? context : null),
    } as unknown as AuthRepository,
    deliveryProvider: { send: async () => undefined },
    otpPepper: 'payment-execution-otp-pepper',
    sessionPepper,
    secureCookie: false,
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('payment execution API authority', () => {
  it('requires a customer session and derives tenant and customer identity server-side', async () => {
    const calls: unknown[][] = []
    const service: PaymentExecutionService = {
      initialize: async (...parameters) => {
        calls.push(parameters)
        return summary
      },
    }
    const app = await buildApp({ auth: authFixture(), paymentExecutionService: service })
    apps.push(app)

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/initialize',
      payload: { paymentId, idempotencyKey: 'payment-execution-key-0001' },
    })
    expect(unauthorized.statusCode).toBe(401)

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/initialize',
      headers: { authorization: `Bearer ${token}`, host: 'tenant.example.test' },
      payload: { paymentId, idempotencyKey: 'payment-execution-key-0001' },
    })
    expect(accepted.statusCode).toBe(201)
    expect(accepted.json()).toMatchObject({ success: true, data: summary })
    expect(calls[0]?.[0]).toBe(tenantId)
    expect(calls[0]?.[1]).toEqual({ type: 'CUSTOMER', id: customerId })
  })

  it('rejects every client-supplied authority field', async () => {
    const service: PaymentExecutionService = { initialize: async () => summary }
    const app = await buildApp({ auth: authFixture(), paymentExecutionService: service })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/initialize',
      headers: { authorization: `Bearer ${token}`, host: 'tenant.example.test' },
      payload: {
        paymentId,
        idempotencyKey: 'payment-execution-key-0002',
        providerCode: 'ATTACKER_SELECTED',
        amount: '1',
        tenantId: '77777777-7777-4777-8777-777777777777',
      },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('payment execution retry classification', () => {
  it('scopes stored request keys by actor without persisting the client key', () => {
    const key = 'payment-execution-shared-key'
    const first = paymentExecutionRequestKey({ type: 'CUSTOMER', id: customerId }, key)
    const second = paymentExecutionRequestKey(
      { type: 'CUSTOMER', id: '77777777-7777-4777-8777-777777777777' },
      key,
    )
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toBe(key)
    expect(second).not.toBe(first)
  })

  it('retries serialization and only the exact preparation idempotency race', () => {
    expect(isRetryablePaymentExecutionConflict({ code: 'P2034' })).toBe(true)
    expect(isRetryablePaymentExecutionConflict({ code: '40001' })).toBe(true)
    expect(isRetryablePaymentExecutionConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(
      true,
    )
    expect(
      isRetryablePaymentExecutionConflict(
        { code: 'P2002', meta: { constraint: 'PaymentAttempt_tenant_idempotency_key' } },
        true,
      ),
    ).toBe(true)
    expect(
      isRetryablePaymentExecutionConflict(
        { code: 'P2002', meta: { constraint: 'PaymentAttempt_provider_reference_key' } },
        true,
      ),
    ).toBe(false)
    expect(
      isRetryablePaymentExecutionConflict(
        {
          code: 'P2002',
          meta: {
            modelName: 'PaymentAttempt',
            target: ['tenantId', 'requestIdempotencyKey'],
          },
        },
        true,
      ),
    ).toBe(true)
    expect(
      isRetryablePaymentExecutionConflict(
        {
          code: 'P2002',
          meta: {
            modelName: 'AnotherModel',
            target: ['tenantId', 'requestIdempotencyKey'],
          },
        },
        true,
      ),
    ).toBe(false)
    expect(isRetryablePaymentExecutionConflict({ code: 'P2002' }, true)).toBe(false)
  })
})
