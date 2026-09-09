import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CartSummary, DeliveryWindow, QuoteSummary, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import { authenticationSessionDigest } from './modules/auth-delivery'
import { CommerceError, type CommerceRepository } from './modules/commerce'

const tenantId = '00000000-0000-4000-8000-000000000001'
const otherTenantId = '00000000-0000-4000-8000-000000000002'
const customerId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const cityId = '33333333-3333-4333-8333-333333333333'
const zoneId = '44444444-4444-4444-8444-444444444444'
const branchId = '55555555-5555-4555-8555-555555555555'
const offeringId = '66666666-6666-4666-8666-666666666666'
const variantId = '77777777-7777-4777-8777-777777777777'
const cartId = '88888888-8888-4888-8888-888888888888'
const addressId = 'abababab-abab-4bab-8bab-abababababab'
const token = 'opaque-session-token'
const sessionPepper = 'commerce-session-pepper-that-is-long-enough'
const now = new Date('2026-07-29T12:00:00.000Z')

const item = {
  id: '99999999-9999-4999-8999-999999999999',
  bakeryProductOfferingId: offeringId,
  productVariantId: variantId,
  bakeryBranchId: branchId,
  sku: 'ALO-SIGNATURE-001',
  nameFa: 'بربری ویژه',
  fulfillmentClass: 'SIGNATURE_FRESH',
  freshnessClaim: 'FRESHLY_PRODUCED',
  quantity: 2,
  unitPrice: { amount: '250000', currency: 'IRR' },
  lineTotal: { amount: '500000', currency: 'IRR' },
} as const

const cart: CartSummary = {
  id: cartId,
  cityId,
  operationalZoneId: zoneId,
  bakeryBranchId: branchId,
  version: 1,
  subtotal: { amount: '500000', currency: 'IRR' },
  items: [item],
  updatedAt: now.toISOString(),
}

const quote: QuoteSummary = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  publicId: 'quote-public-001',
  cartId,
  cartVersion: 1,
  status: 'ACTIVE',
  expiresAt: '2026-07-29T12:10:00.000Z',
  deliveryAddressId: addressId,
  deliveryServiceAreaId: 'acacacac-acac-4cac-8cac-acacacacacac',
  deliveryOperationalZoneId: zoneId,
  deliveryDistanceMeters: 1_234,
  deliveryPricingRuleId: 'adadadad-adad-4dad-8dad-adadadadadad',
  deliveryPricingRuleVersion: 1,
  subtotal: cart.subtotal,
  deliveryFee: { amount: '0', currency: 'IRR' },
  discount: { amount: '0', currency: 'IRR' },
  paymentMethod: 'ONLINE_GATEWAY',
  total: cart.subtotal,
  items: [item],
  createdAt: now.toISOString(),
}

class MemoryCommerceRepository implements CommerceRepository {
  cart: CartSummary | null = null
  quote: QuoteSummary = quote
  customerIds: string[] = []
  failure?: CommerceError

  windows: DeliveryWindow[] = []

  async listDeliveryWindows(
    tenant: string,
    customer: string,
    _now: Date,
  ): Promise<DeliveryWindow[]> {
    this.customerIds.push(`${tenant}:${customer}`)
    if (this.failure) throw this.failure
    return this.windows
  }

  async getCart(tenant: string, customer: string): Promise<CartSummary | null> {
    this.customerIds.push(`${tenant}:${customer}`)
    if (this.failure) throw this.failure
    return this.cart
  }

  async upsertItem(tenant: string, customer: string): Promise<CartSummary> {
    this.customerIds.push(`${tenant}:${customer}`)
    if (this.failure) throw this.failure
    this.cart = cart
    return cart
  }

  async removeItem(tenant: string, customer: string): Promise<CartSummary> {
    this.customerIds.push(`${tenant}:${customer}`)
    if (this.failure) throw this.failure
    this.cart = { ...cart, version: 2, items: [], subtotal: { amount: '0', currency: 'IRR' } }
    return this.cart
  }

  async createQuote(tenant: string, customer: string): Promise<QuoteSummary> {
    this.customerIds.push(`${tenant}:${customer}`)
    if (this.failure) throw this.failure
    return this.quote
  }
}

function authFixture(
  resolvedTenantId: string | null = tenantId,
  sessionTenantId = tenantId,
): AuthDependencies {
  const context: SessionContext = {
    tenantId: sessionTenantId,
    accountId,
    customerId,
    expiresAt: '2026-08-29T12:00:00.000Z',
    grants: [],
  }
  const expectedDigest = authenticationSessionDigest(sessionPepper, token)
  const repository = {
    resolveTenantByHost: async () => resolvedTenantId,
    findSession: async (digest: string, requestedTenantId: string) =>
      digest === expectedDigest && requestedTenantId === context.tenantId ? context : null,
  } as unknown as AuthRepository
  return {
    repository,
    deliveryService: { request: async () => Promise.reject(new Error('unused')) },
    otpPepper: 'commerce-otp-pepper-that-is-long-enough',
    abusePepper: 'commerce-abuse-pepper-that-is-long-enough',
    sessionPepper,
    secureCookie: false,
    now: () => new Date(now),
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
})

describe('server cart and quote API', () => {
  it('rejects every commerce read and write without a valid customer session', async () => {
    const app = await buildApp({
      auth: authFixture(),
      commerceRepository: new MemoryCommerceRepository(),
    })
    apps.push(app)

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/cart' }),
      app.inject({
        method: 'PUT',
        url: `/api/v1/cart/items/${offeringId}`,
        payload: { cityId, operationalZoneId: zoneId, quantity: 1 },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/cart/quote',
        payload: {
          deliveryAddressId: addressId,
          expectedCartVersion: 1,
          idempotencyKey: 'quote-command-0001',
        },
      }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401])
  })

  it('binds mutations to the authenticated customer and returns server totals', async () => {
    const repository = new MemoryCommerceRepository()
    const app = await buildApp({ auth: authFixture(), commerceRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/cart/items/${offeringId}`,
      headers: { cookie: `alo_session=${token}` },
      payload: { cityId, operationalZoneId: zoneId, quantity: 2 },
    })

    expect(response.statusCode).toBe(200)
    expect(repository.customerIds).toEqual([`${tenantId}:${customerId}`])
    expect(response.json()).toMatchObject({
      success: true,
      data: { subtotal: { amount: '500000', currency: 'IRR' } },
    })
    expect(response.body).not.toContain(token)
  })

  it('rejects malformed quantities before the repository is called', async () => {
    const repository = new MemoryCommerceRepository()
    const app = await buildApp({ auth: authFixture(), commerceRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/cart/items/${offeringId}`,
      headers: { cookie: `alo_session=${token}` },
      payload: { cityId, operationalZoneId: zoneId, quantity: 101 },
    })

    expect(response.statusCode).toBe(400)
    expect(repository.customerIds).toEqual([])
  })

  it('returns safe conflict and capacity errors without leaking internals', async () => {
    const repository = new MemoryCommerceRepository()
    repository.failure = new CommerceError('CART_VERSION_CONFLICT', 409)
    const app = await buildApp({ auth: authFixture(), commerceRepository: repository })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/quote',
      headers: { cookie: `alo_session=${token}` },
      payload: {
        deliveryAddressId: addressId,
        expectedCartVersion: 1,
        idempotencyKey: 'quote-command-0001',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'CART_VERSION_CONFLICT' } })
    expect(response.body).not.toContain('postgresql')
  })

  it('returns the same bounded quote for an idempotent replay', async () => {
    const repository = new MemoryCommerceRepository()
    const app = await buildApp({ auth: authFixture(), commerceRepository: repository })
    apps.push(app)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/cart/quote',
      headers: { cookie: `alo_session=${token}` },
      payload: {
        deliveryAddressId: addressId,
        expectedCartVersion: 1,
        idempotencyKey: 'quote-command-0001',
      },
    }

    const first = await app.inject(request)
    const replay = await app.inject(request)

    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(201)
    expect(first.json().data).toEqual(replay.json().data)
    expect(first.json().data).toMatchObject({
      cartVersion: 1,
      expiresAt: '2026-07-29T12:10:00.000Z',
      total: { amount: '500000', currency: 'IRR' },
    })
  })

  it('rejects a token when the verified host tenant differs from the session tenant', async () => {
    const repository = new MemoryCommerceRepository()
    const app = await buildApp({
      auth: authFixture(otherTenantId, tenantId),
      commerceRepository: repository,
    })
    apps.push(app)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { cookie: `alo_session=${token}`, host: 'other.example', 'x-tenant-id': tenantId },
    })
    expect(response.statusCode).toBe(401)
    expect(repository.customerIds).toEqual([])
  })
})
