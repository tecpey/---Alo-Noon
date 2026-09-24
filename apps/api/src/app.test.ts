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

  it('answers a rate-limited request with 429, not with a fault of its own', async () => {
    /*
      Found by hammering a route on the running server, and it was not a small
      thing. `@fastify/rate-limit` does not send what `errorResponseBuilder`
      returns — it throws it — and this app's error handler reads `statusCode`
      off the thrown value. The builder returned the response envelope, which
      has no `statusCode`, so every rate-limited request in the whole API
      answered 500 `INTERNAL_ERROR` and logged at error level as "Unhandled
      error".

      The damage is in what a client does next. A 500 says the shop is broken,
      and the reasonable response to that is to try again — the opposite of
      backing off, so the limiter added load instead of shedding it. On top of
      that, every genuine 5xx was buried in a log full of "Unhandled error"
      lines that were nothing of the kind, and somebody sending money was told
      the service had failed at the moment it was protecting them.
    */
    const app = await buildApp()
    apps.push(app)
    app.get(
      '/limited-for-test',
      { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
      async () => ({ ok: true }),
    )
    await app.ready()

    const first = await app.inject({ method: 'GET', url: '/limited-for-test' })
    expect(first.statusCode).toBe(200)

    const limited = await app.inject({ method: 'GET', url: '/limited-for-test' })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED' },
    })
  })

  it('counts a signed-in customer as themselves, not as their carrier', async () => {
    /*
      The plugin's default key is the client address, and on a mobile network
      that is not one person: carrier-grade NAT puts many subscribers behind one
      public IPv4, which is how operators have coped with IPv4 exhaustion for a
      decade. Nearly every customer of this shop is on a phone.

      Under an IP key they share one budget, and the shop's busiest hour is
      exactly the hour most of them are on the same carrier — so the limiter
      would refuse real customers precisely when it must not, and each of them
      would see a shop that had broken for no reason they could act on.

      Both requests below arrive from the same address. Only the cookie differs.
    */
    const app = await buildApp()
    apps.push(app)
    app.get(
      '/per-person-for-test',
      { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
      async () => ({ ok: true }),
    )
    await app.ready()

    const asPerson = (token: string) =>
      app.inject({
        method: 'GET',
        url: '/per-person-for-test',
        headers: { cookie: `alo_session=${token}` },
      })

    expect((await asPerson('session-one')).statusCode).toBe(200)
    // The same person again: over their own budget, which is the point of a limit.
    expect((await asPerson('session-one')).statusCode).toBe(429)
    // Somebody else, same address. Their budget is their own.
    expect((await asPerson('session-two')).statusCode).toBe(200)
  })

  it('still keys anonymous traffic by address, which is what an address key is for', async () => {
    // Somebody hammering the shop before they have an account is the one case
    // the IP key genuinely answers, and it keeps it.
    const app = await buildApp()
    apps.push(app)
    app.get(
      '/anonymous-for-test',
      { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
      async () => ({ ok: true }),
    )
    await app.ready()

    expect((await app.inject({ method: 'GET', url: '/anonymous-for-test' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/anonymous-for-test' })).statusCode).toBe(429)
  })
})
