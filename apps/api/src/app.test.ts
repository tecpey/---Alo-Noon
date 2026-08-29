import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

describe('operational endpoints', () => {
  it('reports process health', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, data: { status: 'healthy' } })
  })

  it('returns 503 when a dependency is unavailable', async () => {
    const app = await buildApp({ readinessCheck: async () => false })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ success: false, data: { ready: false } })
  })

  it('keeps health independent while failing readiness without authentication delivery', async () => {
    const app = await buildApp({ authenticationDeliveryReadinessCheck: async () => false })
    apps.push(app)

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    const readiness = await app.inject({ method: 'GET', url: '/ready' })
    expect(readiness.statusCode).toBe(503)
    expect(readiness.json()).toMatchObject({
      success: false,
      data: {
        checks: [
          { name: 'database', ready: true },
          { name: 'authentication-delivery', ready: false },
        ],
      },
    })
  })

  it('allows credentials only for configured browser origins', async () => {
    const app = await buildApp({ corsOrigins: ['http://localhost:8081'] })
    apps.push(app)

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/serviceability/cities',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'GET',
      },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:8081')
    expect(allowed.headers['access-control-allow-credentials']).toBe('true')

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/serviceability/cities',
      headers: {
        origin: 'https://attacker.invalid',
        'access-control-request-method': 'GET',
      },
    })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  /**
   * The preflight has to cover every method the API publishes.
   *
   * It did not. @fastify/cors defaults to GET, HEAD and POST, so a browser on
   * an allowed origin could read the catalog and place an order but could not
   * change a basket item or sign out. The refusal arrives as a failed preflight
   * with no status, which surfaces in the app as "could not reach the service"
   * — about a service that is answering everything else.
   *
   * Asserted from the route table rather than a hard-coded list, so a route
   * added with a method nobody allowed fails here instead of in somebody's
   * browser.
   */
  it('preflights every method its own routes serve', async () => {
    const app = await buildApp({ corsOrigins: ['http://localhost:8081'] })
    apps.push(app)

    const served = new Set<string>()
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      for (const method of line.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []) {
        served.add(method)
      }
    }
    expect(served.size).toBeGreaterThan(0)

    for (const method of served) {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/serviceability/cities',
        headers: { origin: 'http://localhost:8081', 'access-control-request-method': method },
      })
      const allowed = String(preflight.headers['access-control-allow-methods'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
      expect(allowed).toContain(method)
    }
  })
})
