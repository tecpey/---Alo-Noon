import { afterEach, describe, expect, it, vi } from 'vitest'

import { reorderEnvelopeSchema, responseMetaSchema, type SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDependencies, AuthRepository } from './modules/auth'

/**
 * These routes must answer in the shape the contracts publish.
 *
 * They did not. Every engagement route emitted `apiVersion` where the envelope
 * says `version`, and shipped that way because nothing checked: the web client
 * does not validate what it receives, and the service tests below this layer
 * never see an envelope at all. The mobile client does validate, so the first
 * thing to notice was a reorder from a phone failing with "the service reply
 * was not valid" against a cheerful 201.
 *
 * Parsing real responses with the published schema is what closes that gap. A
 * test that asserted the fields by hand would have been written with the same
 * wrong key.
 */
const tenantId = '00000000-0000-4000-8000-000000000001'
const customerId = '00000000-0000-4000-8000-0000000000c9'
const accountId = '00000000-0000-4000-8000-0000000000a9'
const orderId = '00000000-0000-4000-8000-0000000000d9'
const offeringId = '00000000-0000-4000-8000-0000000000e9'

const session: SessionContext = {
  accountId,
  tenantId,
  customerId,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  grants: [],
}

function authFixture(): AuthDependencies {
  return {
    repository: {
      resolveTenantByHost: async () => tenantId,
      findSession: async () => session,
    } as unknown as AuthRepository,
    deliveryService: { request: async () => Promise.reject(new Error('unused')) },
    otpPepper: 'engagement-otp-pepper',
    abusePepper: 'engagement-abuse-pepper',
    sessionPepper: 'engagement-session-pepper',
    secureCookie: false,
  }
}

const apps: { close: () => Promise<void> }[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()?.close()
})

const headers = { host: 'localhost', authorization: 'Bearer token' }

async function appWith(service: Record<string, unknown>) {
  const app = await buildApp({
    auth: authFixture(),
    engagement: { service: service as never },
  })
  apps.push(app)
  return app
}

describe('engagement route envelopes', () => {
  it('answers a reorder in the shape the contract publishes', async () => {
    const app = await appWith({
      reorder: vi.fn().mockResolvedValue({
        cartId: '00000000-0000-4000-8000-0000000000f9',
        addedCount: 2,
        adjustments: [
          {
            offeringId,
            nameFa: 'سنگک کنجدی',
            reason: 'REORDER_QUANTITY_REDUCED',
            quantity: 1,
          },
        ],
      }),
    })

    const response = await app.inject({
      method: 'POST',
      headers,
      url: `/api/v1/orders/${orderId}/reorder`,
    })

    expect(response.statusCode).toBe(201)
    // The whole envelope, not just the payload: the bug was in `meta`.
    const parsed = reorderEnvelopeSchema.safeParse(response.json())
    expect(parsed.success).toBe(true)
  })

  it('stamps every engagement response with the published meta', async () => {
    // Favourites has no envelope schema of its own, so this checks the part
    // that was actually wrong and is shared by every route in the module.
    const app = await appWith({ listFavourites: vi.fn().mockResolvedValue([]) })

    const response = await app.inject({ method: 'GET', headers, url: '/api/v1/favourites' })

    expect(response.statusCode).toBe(200)
    const parsed = responseMetaSchema.safeParse(response.json().meta)
    expect(parsed.success).toBe(true)
  })
})
