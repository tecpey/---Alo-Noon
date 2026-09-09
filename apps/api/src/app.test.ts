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

/**
 * The two answers that used to escape the envelope.
 *
 * Every route in this API replies `{ success, data | error, meta }`, and two
 * paths never reached a route to do it: an unmatched URL and a body that is not
 * the JSON its own content-type claims. Fastify answered both in its own shape,
 * carrying an internal framework code and no requestId — so a client that
 * trusts the envelope met a response it could not read, on the two failures it
 * is most likely to meet.
 */
describe('every answer, including the ones no route produced', () => {
  it('envelopes an unmatched URL, without echoing it back', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/v1/no-such-thing' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'ROUTE_NOT_FOUND' },
    })
    // The path is not repeated into the body. Nothing needs telling a caller
    // what they just asked for, and reflecting input is a habit worth not having.
    expect(response.body).not.toContain('no-such-thing')
    // Traceable: a failure a customer reports and a line in the log are only
    // the same event if something connects them.
    expect(response.json().meta.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('envelopes a body that is not the JSON it claims to be', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken',
    })

    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.success).toBe(false)
    // A code this API owns. `FST_ERR_CTP_INVALID_JSON_BODY` names the framework
    // rather than the fault, and it is the framework's to rename on an upgrade.
    expect(body.error.code).toBe('INVALID_REQUEST')
    expect(response.body).not.toContain('FST_ERR')
    // The parser's own sentence survives, because it says something true about
    // the request that was sent — but wrapped, coded and traceable like
    // everything else.
    expect(body.error.message).toBeTruthy()
    expect(body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.statusCode).toBeUndefined()
  })

  it('never returns a thrown message on a fault of its own', async () => {
    const app = await buildApp()
    apps.push(app)
    app.get('/boom-for-test', async () => {
      throw new Error('connection to postgres://user:hunter2@db.internal failed')
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/boom-for-test' })
    expect(response.statusCode).toBe(500)
    // Whatever raised it was not written to be read by a stranger, and the ones
    // that are — a driver's error, a provider's body — are exactly the ones
    // carrying a hostname, a query or a credential.
    expect(response.body).not.toContain('hunter2')
    expect(response.body).not.toContain('db.internal')
    expect(response.json()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } })
  })
})
