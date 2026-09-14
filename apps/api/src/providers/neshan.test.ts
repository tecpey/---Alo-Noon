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

/*
 * Search and reverse geocoding.
 *
 * These matter for a reason the route tests do not share: they are the only way
 * a customer who will not or cannot give a satellite position can place an
 * order at all. A silent failure here is not a slightly wrong fare, it is a
 * checkout that cannot be completed.
 */
function placesRequest(term: string, bias?: { latitude: number; longitude: number }) {
  return {
    term,
    ...(bias && { bias }),
    timeoutMs: 3_000,
    configuration: baseRequest().configuration,
    credential: credential(),
  }
}

function reverseRequest(coordinates = HOME) {
  return {
    coordinates,
    timeoutMs: 3_000,
    configuration: baseRequest().configuration,
    credential: credential(),
  }
}

describe('searching Neshan for a place', () => {
  it('sends term, lat and lng as separate parameters, with the key in the header', async () => {
    // Deliberately asserted: `/v2/direction` takes a joined "lat,lng" pair and
    // this endpoint takes two parameters. Copying the routing call's format
    // here would produce a request Neshan answers with nothing, and nothing is
    // indistinguishable from "we do not know that street".
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        json({ count: 1, items: [{ title: 'نانوایی سنگکی', location: { y: 36.55, x: 52.69 } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.searchPlaces!(placesRequest('سنگکی', BRANCH))

    expect(result.outcome).toBe('FOUND')
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe('https://api.neshan.org/v1/search')
    expect(url.searchParams.get('term')).toBe('سنگکی')
    expect(url.searchParams.get('lat')).toBe('36.5442')
    expect(url.searchParams.get('lng')).toBe('52.6781')
    expect((init.headers as Record<string, string>)['Api-Key']).toBe('service.test-key')
  })

  it('omits the bias entirely when none was given', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ count: 0, items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await adapter.searchPlaces!(placesRequest('میدان'))

    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.searchParams.has('lat')).toBe(false)
    expect(url.searchParams.has('lng')).toBe(false)
  })

  it('reads the coordinate whichever way the item spells it', async () => {
    // The client's docstring establishes `count` and `items` and nothing about
    // what is inside an item, so both plausible spellings are accepted rather
    // than one being guessed at.
    const fetchMock = vi.fn().mockImplementation(async () =>
      json({
        count: 2,
        items: [
          { title: 'الف', location: { y: 36.55, x: 52.69 }, address: 'بابل، نشانی یک' },
          { name: 'ب', latitude: 36.56, longitude: 52.7, distance: 812.4 },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.searchPlaces!(placesRequest('بابل'))

    expect(result.outcome).toBe('FOUND')
    expect(result.candidates).toEqual([
      {
        title: 'الف',
        address: 'بابل، نشانی یک',
        coordinates: { latitude: 36.55, longitude: 52.69 },
        distanceMetres: null,
      },
      {
        title: 'ب',
        address: null,
        coordinates: { latitude: 36.56, longitude: 52.7 },
        distanceMetres: 812,
      },
    ])
  })

  it('drops an item with no usable coordinate rather than showing it', async () => {
    // Its only purpose is to become a delivery address. One that cannot is a row
    // the customer can select and then fail to order from, which reads as the
    // shop being broken.
    const fetchMock = vi.fn().mockImplementation(async () =>
      json({
        count: 2,
        items: [{ title: 'بی‌مختصات' }, { title: 'درست', location: { y: 36.55, x: 52.69 } }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.searchPlaces!(placesRequest('بابل'))

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates?.[0]?.title).toBe('درست')
  })

  it('refuses a coordinate outside the planet, which is x and y swapped', async () => {
    // 52.69 as a latitude is northern Europe; the pair arriving the other way
    // round is the realistic bug, and it would send bread to the North Sea.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        json({ count: 1, items: [{ title: 'وارونه', location: { y: 52.69, x: 236.55 } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    expect((await adapter.searchPlaces!(placesRequest('بابل'))).outcome).toBe('EMPTY')
  })

  it('caps the list rather than handing over everything Neshan sent', async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      title: `مکان ${index}`,
      location: { y: 36.55, x: 52.69 },
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ count: 30, items })),
    )

    const result = await adapter.searchPlaces!(placesRequest('بابل'))

    expect(result.candidates).toHaveLength(8)
  })

  it('treats a non-ok status inside a 200 as a failure, not as an empty result', async () => {
    // The whole error envelope lives inside a successful HTTP response, so the
    // status code alone never decides this. Reported as UNAVAILABLE because
    // "the key is exhausted" must not look like "nowhere is called that".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ status: 'error', code: -4, message: 'no' })),
    )

    const result = await adapter.searchPlaces!(placesRequest('بابل'))

    expect(result.outcome).toBe('UNAVAILABLE')
    expect(result.reasonCode).toBe('NESHAN_ERROR_NEG_4')
  })

  it('reports an outage rather than throwing when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')))

    const result = await adapter.searchPlaces!(placesRequest('بابل'))

    expect(result).toEqual({ outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_REQUEST_FAILED' })
  })
})

describe('asking Neshan what is at a point', () => {
  it('sends lat and lng separately and returns the line the provider assembled', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json({ formatted_address: 'مازندران، بابل، خیابان مدرس' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await adapter.reverseGeocode!(reverseRequest())

    expect(result).toEqual({
      outcome: 'RESOLVED',
      formattedAddress: 'مازندران، بابل، خیابان مدرس',
    })
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.origin + url.pathname).toBe('https://api.neshan.org/v2/reverse')
    expect(url.searchParams.get('lat')).toBe('36.5501')
    expect(url.searchParams.get('lng')).toBe('52.6899')
  })

  it('never stitches an address together out of parts', async () => {
    // The customer reads this back to decide whether the pin is their house. A
    // sentence assembled from fields whose meaning was guessed at is a
    // confident-looking answer that sends bread to the wrong door, and an
    // honest blank leaves them to check the map instead.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json({ state: 'مازندران', city: 'بابل', neighbourhood: 'گنج‌افروز' }),
        ),
    )

    const result = await adapter.reverseGeocode!(reverseRequest())

    expect(result).toEqual({ outcome: 'EMPTY', reasonCode: 'NESHAN_NO_ADDRESS' })
  })

  it('accepts the camelCase spelling too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({ formattedAddress: 'بابل، بلوار طالقانی' })),
    )

    const result = await adapter.reverseGeocode!(reverseRequest())

    expect(result.formattedAddress).toBe('بابل، بلوار طالقانی')
  })

  it('reports an HTTP failure as an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => json({}, 429)),
    )

    const result = await adapter.reverseGeocode!(reverseRequest())

    expect(result).toEqual({ outcome: 'UNAVAILABLE', reasonCode: 'NESHAN_HTTP_429' })
  })
})
