import { afterEach, describe, expect, it, vi } from 'vitest'

import { routeDistanceFrom, type RouteRequest } from '@alo-noon/domain'

import { createNeshanAdapter } from './neshan'

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const HOME = { latitude: 36.5501, longitude: 52.6899 }

function credential(key = 'service.test-key') {
  const material = new TextEncoder().encode(key)
  return { material, dispose: vi.fn() }
}

function baseRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    origin: BRANCH,
    destination: HOME,
    profile: 'MOTORCYCLE',
    restrictions: { avoidTrafficZone: false, avoidOddEvenZone: false },
    timeoutMs: 3_000,
    configuration: {
      id: 'config-1',
      tenantId: 'tenant-1',
      providerCode: 'NESHAN',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
      credentialReference: 'env://ROUTING_NESHAN_KEY',
    },
    credential: credential(),
    ...overrides,
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status })
}

/** The shape Neshan's direction reply is expected to take. */
function route(legs: readonly { distance: number; duration?: number }[]) {
  return {
    routes: [
      {
        legs: legs.map((leg) => ({
          distance: { value: leg.distance, text: `${leg.distance} متر` },
          ...(leg.duration !== undefined && {
            duration: { value: leg.duration, text: `${leg.duration} ثانیه` },
          }),
        })),
      },
    ],
  }
}

const adapter = createNeshanAdapter()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('asking Neshan for a route', () => {
  it('sends the key in the header and the points as lat,lng', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json(route([{ distance: 2_480 }])))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.route(baseRequest())

    expect(result.outcome).toBe('ROUTED')
    expect(result.distanceMetres).toBe(2_480)

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe('https://api.neshan.org/v2/direction')
    expect(url.searchParams.get('origin')).toBe('36.5442,52.6781')
    expect(url.searchParams.get('destination')).toBe('36.5501,52.6899')
    // A key in the query string would land in every access log between here and
    // Neshan; the client puts it in a header and so does this.
    expect((init.headers as Record<string, string>)['Api-Key']).toBe('service.test-key')
    expect(url.search).not.toContain('service.test-key')
  })

  it('sends the Iranian zone restrictions only when they apply', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json(route([{ distance: 100 }])))
    vi.stubGlobal('fetch', fetchMock)

    await adapter.route(baseRequest())
    const unrestricted = fetchMock.mock.calls[0]?.[0] as URL
    expect(unrestricted.searchParams.has('avoidTrafficZone')).toBe(false)
    expect(unrestricted.searchParams.has('avoidOddEvenZone')).toBe(false)

    await adapter.route(
      baseRequest({ restrictions: { avoidTrafficZone: true, avoidOddEvenZone: true } }),
    )
    const restricted = fetchMock.mock.calls[1]?.[0] as URL
    expect(restricted.searchParams.get('avoidTrafficZone')).toBe('true')
    expect(restricted.searchParams.get('avoidOddEvenZone')).toBe('true')
  })

  it('passes waypoints pipe separated, in the order they are to be visited', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json(route([{ distance: 900 }, { distance: 1_100 }])))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.route(
      baseRequest({ waypoints: [{ latitude: 36.547, longitude: 52.684 }] }),
    )

    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.searchParams.get('waypoints')).toBe('36.547,52.684')
    // A multi-drop run is the sum of its legs, not the length of the last one.
    expect(result.distanceMetres).toBe(2_000)
    expect(result.legs).toHaveLength(2)
  })

  it('sums the durations only when every leg has one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json(route([{ distance: 900, duration: 120 }, { distance: 1_100 }])),
        ),
    )

    const result = await adapter.route(baseRequest())

    expect(result.distanceMetres).toBe(2_000)
    // Half a journey's duration presented as the whole would be an arrival time
    // told to a customer that nothing supports.
    expect(result.durationSeconds).toBeUndefined()
  })

  it('accepts a bare number where the reply carries no value wrapper', async () => {
    // The wrapped shape is the documented convention, but it could not be
    // confirmed from source; reading both is what keeps a shape surprise from
    // silently turning into a fallback on every order.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ routes: [{ legs: [{ distance: 1_500 }] }] })),
    )

    const result = await adapter.route(baseRequest())

    expect(result.outcome).toBe('ROUTED')
    expect(result.distanceMetres).toBe(1_500)
  })

  it('reports no route rather than an outage when Neshan says there is none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ routes: [] })),
    )

    const result = await adapter.route(baseRequest())

    // An unreachable address is the operator's problem, not the platform's, and
    // the two must not arrive in the same alert.
    expect(result.outcome).toBe('UNROUTABLE')
    expect(result.reasonCode).toBe('NESHAN_NO_ROUTE')
  })

  it('reads a failure reported inside a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json({ status: 'InvalidKey', code: 470, message: 'کلید نامعتبر' }),
        ),
    )

    const result = await adapter.route(baseRequest())

    expect(result.outcome).toBe('UNAVAILABLE')
    expect(result.reasonCode).toBe('NESHAN_INVALIDKEY_470')
  })

  it('treats a zero-results status as an unreachable address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ status: 'ZERO_RESULTS', routes: [] })),
    )

    expect((await adapter.route(baseRequest())).outcome).toBe('UNROUTABLE')
  })

  it.each([
    ['a rate limit', 429],
    ['an outage', 503],
    ['a rejected key', 401],
  ])('reports %s as unavailable, with the status kept', async (_label, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({}, status)),
    )

    const result = await adapter.route(baseRequest())

    expect(result.outcome).toBe('UNAVAILABLE')
    expect(result.reasonCode).toBe(`NESHAN_HTTP_${status}`)
  })

  it('drops a route whose leg carries no usable distance', async () => {
    // Counting the unreadable leg as zero would quietly shorten the journey and
    // undercharge for it, which is worse than falling back.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json({
          routes: [{ legs: [{ distance: { value: 900 } }, { duration: { value: 60 } }] }],
        }),
      ),
    )

    const result = await adapter.route(baseRequest())

    expect(result.outcome).toBe('UNAVAILABLE')
    expect(result.reasonCode).toBe('NESHAN_ROUTE_UNREADABLE')
    expect(routeDistanceFrom(result, BRANCH, HOME).source).toBe('ESTIMATED')
  })

  it('refuses a negative distance rather than routing on it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json({ routes: [{ legs: [{ distance: { value: -5 } }] }] }),
        ),
    )

    expect((await adapter.route(baseRequest())).outcome).toBe('UNAVAILABLE')
  })

  it('reports a timeout or a refused connection as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('AbortError')))

    expect(await adapter.route(baseRequest())).toEqual({
      outcome: 'UNAVAILABLE',
      reasonCode: 'NESHAN_REQUEST_FAILED',
    })
  })

  it('does not call the network with a credential it cannot read', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.route(baseRequest({ credential: credential('   ') }))

    expect(result.reasonCode).toBe('NESHAN_CREDENTIAL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours an endpoint origin override while keeping Neshan paths', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json(route([{ distance: 10 }])))
    vi.stubGlobal('fetch', fetchMock)

    const local = createNeshanAdapter({ endpointOrigin: 'http://127.0.0.1:4190/' })
    await local.route(baseRequest())

    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:4190/v2/direction')
  })
})
