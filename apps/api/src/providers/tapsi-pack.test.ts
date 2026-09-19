import { afterEach, describe, expect, it, vi } from 'vitest'

import { DELIVERY_FARE_ADAPTER_SPI_VERSION, type FareQuoteRequest } from '@alo-noon/domain'

import { createTapsiPackAdapter, parseTapsiPackReference } from './tapsi-pack'

const now = new Date('2026-09-19T05:00:00.000Z')

const credential = (value: unknown = { secretKey: 'secret-abc', userId: '123' }) => ({
  material: new TextEncoder().encode(JSON.stringify(value)),
  dispose: () => {},
})

const request = (overrides: Partial<FareQuoteRequest> = {}): FareQuoteRequest => ({
  origin: { latitude: 36.5387, longitude: 52.6765 },
  destination: { latitude: 36.5513, longitude: 52.679 },
  profile: 'MOTORCYCLE',
  distanceMetres: 1_800,
  durationSeconds: null,
  itemCount: 3,
  requestedAt: now,
  timeoutMs: 4_000,
  configuration: {
    id: 'configuration',
    tenantId: 'tenant',
    providerCode: 'TAPSI_PACK',
    adapterVersion: '1.0.0',
    adapterSpiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,
    environment: 'TEST',
    credentialReference: 'env://DELIVERY_FARE_TAPSI_PACK',
  },
  credential: credential(),
  ...overrides,
})

/** A preview shaped as the published swagger describes it. */
const preview = (overrides: Record<string, unknown> = {}) => ({
  token: 'session-token-xyz',
  invoicePerTimeslots: [
    {
      timeslotId: 'slot-1',
      startTimestamp: 1_789_000_000_000,
      endTimestamp: 1_789_003_600_000,
      isAvailable: false,
      invoice: null,
    },
    {
      timeslotId: 'slot-2',
      startTimestamp: 1_789_003_600_000,
      endTimestamp: 1_789_007_200_000,
      isAvailable: true,
      invoice: {
        discount: 5_000,
        amount: 85_000,
        paymentInAdvance: 60_000,
        descriptions: [
          { title: 'کرایهٔ پایه', amount: 70_000 },
          { title: 'هزینهٔ مسافت', amount: 15_000 },
        ],
      },
    },
  ],
  ...overrides,
})

function mockFetch(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Tapsi Pack fare quotes', () => {
  it('calls the documented preview endpoint with the documented headers', async () => {
    const fetchMock = mockFetch(preview())
    await createTapsiPackAdapter().quoteFare(request())

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe(
      'https://api.tapsi.cab/api/v1/delivery/external/embedded/order/preview',
    )
    expect(url.searchParams.get('originLat')).toBe('36.5387')
    expect(url.searchParams.get('destinationLong')).toBe('52.679')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-secret-key']).toBe('secret-abc')
    // The authorization document's own example: user 123 encodes to "MTIz".
    expect(headers['x-encoded-user-id']).toBe('MTIz')
  })

  it('charges the total less the discount, not the total and not the advance', async () => {
    // 85,000 − 5,000. Using `amount` would pass on a discount Tapsi gave us;
    // using `paymentInAdvance` would subtract account credit, which is money
    // already paid rather than money saved.
    mockFetch(preview())
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(quote.amount).toBe(80_000n)
    expect(quote.currency).toBe('IRR')
  })

  it('skips an unavailable timeslot and prices the first bookable one', async () => {
    mockFetch(preview())
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(quote.providerReference.startsWith('slot-2:')).toBe(true)
  })

  it('carries both halves of what a submit needs, recoverable in either order', async () => {
    mockFetch(preview())
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(parseTapsiPackReference(quote.providerReference)).toEqual({
      timeslotId: 'slot-2',
      token: 'session-token-xyz',
    })
  })

  it('keeps a token containing a colon intact', async () => {
    mockFetch(preview({ token: 'aa:bb:cc' }))
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(parseTapsiPackReference(quote.providerReference)?.token).toBe('aa:bb:cc')
  })

  it('converts a Toman account into Rial rather than undercharging tenfold', async () => {
    mockFetch(preview())
    const quote = await createTapsiPackAdapter({ amountUnit: 'TOMAN' }).quoteFare(request())
    expect(quote.amount).toBe(800_000n)
  })

  it('passes seconds when the account expects seconds', async () => {
    const fetchMock = mockFetch(preview())
    await createTapsiPackAdapter({ timestampUnit: 'SECONDS' }).quoteFare(request())
    const [url] = fetchMock.mock.calls[0] as unknown as [URL]
    expect(url.searchParams.get('dateTimestamp')).toBe(String(now.getTime() / 1000))
  })

  it('reports Tapsi’s own itemisation in Tapsi’s own words', async () => {
    mockFetch(preview())
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(quote.components?.map((component) => component.labelFa)).toEqual([
      'کرایهٔ پایه',
      'هزینهٔ مسافت',
    ])
  })

  it('refuses to price an order that needs a car', async () => {
    // The documented preview takes no vehicle, so a price returned here would
    // be a motorcycle's fare for a car's job.
    const fetchMock = mockFetch(preview())
    await expect(createTapsiPackAdapter().quoteFare(request({ profile: 'CAR' }))).rejects.toThrow(
      'TAPSI_PACK_VEHICLE_UNSUPPORTED',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declines when no timeslot can be booked', async () => {
    mockFetch(
      preview({
        invoicePerTimeslots: [{ timeslotId: 's', isAvailable: false, invoice: null }],
      }),
    )
    await expect(createTapsiPackAdapter().quoteFare(request())).rejects.toThrow(
      'TAPSI_PACK_NO_AVAILABLE_TIMESLOT',
    )
  })

  it('declines a refused request rather than inventing a fare', async () => {
    mockFetch({ message: 'nope' }, { status: 401 })
    await expect(createTapsiPackAdapter().quoteFare(request())).rejects.toThrow(
      'TAPSI_PACK_HTTP_401',
    )
  })

  it('declines a shape it does not recognise instead of guessing at it', async () => {
    // A surprise costs a fallback to our own tariff — one slightly wrong fare.
    // Guessing would be a confidently wrong fare on every order.
    mockFetch({ token: 'x', invoicePerTimeslots: [{ timeslotId: 's', isAvailable: true }] })
    await expect(createTapsiPackAdapter().quoteFare(request())).rejects.toThrow()
  })

  it('refuses a non-integer amount rather than rounding somebody else’s money', async () => {
    mockFetch(
      preview({
        invoicePerTimeslots: [
          {
            timeslotId: 'slot-1',
            isAvailable: true,
            invoice: { amount: 80_000.5, discount: 0, descriptions: [] },
          },
        ],
      }),
    )
    await expect(createTapsiPackAdapter().quoteFare(request())).rejects.toThrow()
  })

  it('refuses a half-configured credential', async () => {
    await expect(
      createTapsiPackAdapter().quoteFare(request({ credential: credential({ secretKey: 'a' }) })),
    ).rejects.toThrow('TAPSI_PACK_CREDENTIAL_INCOMPLETE')
  })

  it('refuses a credential that is not the documented JSON', async () => {
    await expect(
      createTapsiPackAdapter().quoteFare(
        request({
          credential: { material: new TextEncoder().encode('raw-key'), dispose: () => {} },
        }),
      ),
    ).rejects.toThrow('TAPSI_PACK_CREDENTIAL_MALFORMED')
  })

  it('holds a quote for a bounded time rather than indefinitely', async () => {
    mockFetch(preview())
    const quote = await createTapsiPackAdapter().quoteFare(request())
    expect(quote.expiresAt.getTime()).toBe(now.getTime() + 5 * 60_000)
  })
})

describe('reading a stored reference back', () => {
  it('rejects a reference with nothing on either side of the separator', () => {
    expect(parseTapsiPackReference(':token')).toBeNull()
    expect(parseTapsiPackReference('slot:')).toBeNull()
    expect(parseTapsiPackReference('no-separator')).toBeNull()
  })
})
