import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app'
import type { PushDeviceService } from './modules/push-devices'

/**
 * The routes, as an HTTP client meets them.
 *
 * Worth its own file because the failure it catches is one no unit test can:
 * a route that is written and never registered answers 404, and a 404 on
 * registration means a customer's browser quietly never subscribes. Nothing in
 * this repository would notice — the notification path would go on sending SMS,
 * which is exactly what it did before, and the bill would be the only evidence.
 */

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

const HOST = 'shop.example.test'

const SUBSCRIPTION = {
  endpoint: 'https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
  keys: {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
}

const VAPID_PUBLIC_KEY =
  'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs'

const service: PushDeviceService = {
  async register(_tenantId, _customerId, input) {
    return {
      id: '00000000-0000-4000-8000-00000000d001',
      platform: input.platform,
      enabled: true,
      lastSeenAt: '2026-09-17T06:00:00.000Z',
    }
  },
  async forget() {},
  async listForCustomer() {
    return []
  },
  async recordOutcome() {},
}

/** Enough of the auth surface for the routes to resolve a host and a session. */
function auth(tenantId: string | null) {
  return {
    repository: {
      resolveTenantByHost: async (host: string) => (host === HOST ? tenantId : null),
    },
  } as unknown as Parameters<typeof buildApp>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof buildApp>[0]>['auth']
}

async function appWith(options: { tenantId?: string | null; publicKey?: string }) {
  const built = await buildApp({
    auth: auth(options.tenantId === undefined ? 'tenant-1' : options.tenantId),
    pushDevices: {
      service,
      ...(options.publicKey !== undefined && { webPushPublicKey: options.publicKey }),
    },
  })
  apps.push(built)
  return built
}

describe('the key a browser subscribes with', () => {
  it('is served, so a rotation does not wait for every cached page', async () => {
    const app = await appWith({ publicKey: VAPID_PUBLIC_KEY })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/push/web-key',
      headers: { host: HOST },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      data: { publicKey: VAPID_PUBLIC_KEY },
    })
    expect(response.headers['cache-control']).toContain('max-age=3600')
  })

  /**
   * Null is a real answer: this deployment has no VAPID keys. The client must
   * be able to tell that apart from a failure, because the right response is to
   * *not* ask for notification permission — on most browsers a permission once
   * refused cannot be asked about again, so a prompt that could never have
   * worked costs the customer the chance to say yes later.
   */
  it('answers null rather than failing when no keys are configured', async () => {
    const app = await appWith({})
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/push/web-key',
      headers: { host: HOST },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ publicKey: null })
  })

  it('is not the one route that answers a host belonging to nobody', async () => {
    const app = await appWith({ tenantId: null, publicKey: VAPID_PUBLIC_KEY })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/push/web-key',
      headers: { host: 'somebody-elses.example.test' },
    })

    expect(response.statusCode).toBe(404)
  })
})

describe('registering a device', () => {
  it('is registered rather than merely written', async () => {
    // A route that exists in the source and not in the server answers 404, and
    // a 404 here is a browser that silently never subscribes.
    const app = await appWith({ publicKey: VAPID_PUBLIC_KEY })
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/push/devices',
      headers: { host: HOST },
      payload: { platform: 'WEB', subscription: SUBSCRIPTION },
    })

    // 401, not 404: the route is there and is asking who this is.
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } })
  })

  /**
   * Signing out is registered too, and asks who is signing out before it reads
   * what they sent. An anonymous caller learns nothing about which addresses
   * this API considers well formed — and, more to the point, cannot reach the
   * delete at all.
   */
  it('guards forgetting a device behind the same session', async () => {
    const app = await appWith({ publicKey: VAPID_PUBLIC_KEY })
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/push/devices',
      headers: { host: HOST },
      payload: { endpoint: SUBSCRIPTION.endpoint },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } })
  })
})
