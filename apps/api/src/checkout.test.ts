import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { AddressSummary, OrderSummary, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AddressRepository } from './modules/addresses'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import { isSerializationFailure, type OrderRepository } from './modules/orders'

const tenantId = '00000000-0000-4000-8000-000000000001'
const customerId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const cityId = '33333333-3333-4333-8333-333333333333'
const addressId = '44444444-4444-4444-8444-444444444444'
const quoteId = '55555555-5555-4555-8555-555555555555'
const token = 'checkout-session-token'
const sessionPepper = 'checkout-session-pepper-that-is-long-enough'

const address: AddressSummary = {
  id: addressId,
  cityId,
  serviceAreaId: '66666666-6666-4666-8666-666666666666',
  operationalZoneId: '77777777-7777-4777-8777-777777777777',
  label: 'خانه',
  recipientName: 'مشتری تست',
  recipientPhone: '+989111111111',
  addressLine: 'بابل، نشانی کامل و معتبر برای تحویل',
  latitude: 36.5387,
  longitude: 52.6765,
  verificationStatus: 'CUSTOMER_CONFIRMED',
  createdAt: '2026-08-02T10:00:00.000Z',
}

const order: OrderSummary = {
  id: '88888888-8888-4888-8888-888888888888',
  publicId: 'order-public-001',
  quoteId,
  state: 'PENDING_CONFIRMATION',
  paymentState: 'NOT_STARTED',
  productionState: 'UNSCHEDULED',
  deliveryState: 'UNASSIGNED',
  subtotal: { amount: '500000', currency: 'IRR' },
  deliveryFee: { amount: '50000', currency: 'IRR' },
  discount: { amount: '0', currency: 'IRR' },
  total: { amount: '550000', currency: 'IRR' },
  items: [],
  createdAt: '2026-08-02T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
}

function authFixture(): AuthDependencies {
  const context: SessionContext = {
    tenantId,
    accountId,
    customerId,
    expiresAt: '2026-09-02T10:00:00.000Z',
    grants: [],
  }
  const digest = createHmac('sha256', sessionPepper).update(token).digest('hex')
  return {
    repository: {
      resolveTenantByHost: async () => tenantId,
      findSession: async (value: string) => (value === digest ? context : null),
    } as unknown as AuthRepository,
    deliveryProvider: { send: async () => undefined },
    otpPepper: 'checkout-otp-pepper-that-is-long-enough',
    sessionPepper,
    secureCookie: false,
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('authenticated checkout API boundary', () => {
  it('does not expose address or order writes without a customer session', async () => {
    const app = await buildApp({
      auth: authFixture(),
      addressRepository: { list: async () => [], create: async () => address },
      orderRepository: { create: async () => order },
    })
    apps.push(app)
    const [addresses, createAddress, createOrder] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/addresses' }),
      app.inject({ method: 'POST', url: '/api/v1/addresses', payload: {} }),
      app.inject({ method: 'POST', url: '/api/v1/orders', payload: {} }),
    ])
    expect([addresses.statusCode, createAddress.statusCode, createOrder.statusCode]).toEqual([
      401, 401, 401,
    ])
  })

  it('derives tenant and customer ownership from the verified session', async () => {
    const calls: string[] = []
    const addressRepository: AddressRepository = {
      list: async (tenant, customer) => {
        calls.push(`list:${tenant}:${customer}`)
        return [address]
      },
      create: async (tenant, customer) => {
        calls.push(`create:${tenant}:${customer}`)
        return address
      },
    }
    const orderRepository: OrderRepository = {
      create: async (tenant, customer) => {
        calls.push(`order:${tenant}:${customer}`)
        return order
      },
    }
    const app = await buildApp({ auth: authFixture(), addressRepository, orderRepository })
    apps.push(app)
    const headers = { cookie: `alo_session=${token}` }
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/addresses', headers }),
      app.inject({
        method: 'POST',
        url: '/api/v1/addresses',
        headers,
        payload: {
          cityId,
          label: 'خانه',
          recipientName: 'مشتری تست',
          recipientPhone: '+989111111111',
          addressLine: 'بابل، نشانی کامل و معتبر برای تحویل',
          latitude: 36.5387,
          longitude: 52.6765,
          idempotencyKey: 'address-command-0001',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers,
        payload: {
          quoteId,
          idempotencyKey: 'order-command-0001',
        },
      }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 201, 201])
    expect(calls).toEqual([
      `list:${tenantId}:${customerId}`,
      `create:${tenantId}:${customerId}`,
      `order:${tenantId}:${customerId}`,
    ])
    expect(responses[2]!.body).not.toContain('idempotencyKey')
  })

  it('rejects client attempts to replace the safe order command', async () => {
    let called = false
    const app = await buildApp({
      auth: authFixture(),
      orderRepository: {
        create: async () => {
          called = true
          return order
        },
      },
    })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: `alo_session=${token}` },
      payload: { quoteId, idempotencyKey: 'short', totalAmount: '1', tenantId },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_ORDER_REQUEST' } })
    expect(called).toBe(false)
  })
})

describe('order transaction conflict classification', () => {
  it('recognizes PostgreSQL serialization failures wrapped by Prisma raw queries', () => {
    expect(isSerializationFailure({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
    expect(isSerializationFailure({ code: 'P2034' })).toBe(true)
    expect(isSerializationFailure({ code: 'P2002' })).toBe(true)
    expect(isSerializationFailure({ code: 'P2010', meta: { code: '23505' } })).toBe(false)
    expect(isSerializationFailure(new Error('could not serialize access'))).toBe(false)
  })
})
