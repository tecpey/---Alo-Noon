import { afterEach, describe, expect, it, vi } from 'vitest'

import { DELIVERY_FARE_ADAPTER_SPI_VERSION, type FareQuoteRequest } from '@alo-noon/domain'

import { createSnappBoxAdapter } from './snapp-box'

const now = new Date('2026-09-23T05:00:00.000Z')

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
    providerCode: 'SNAPP_BOX',
    adapterVersion: '1.0.0',
    adapterSpiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,
    environment: 'TEST',
    credentialReference: 'env://DELIVERY_FARE_SNAPP_BOX',
  },
  credential: { material: new TextEncoder().encode('snapp-api-key'), dispose: () => {} },
  ...overrides,
})

/** A pricing response shaped as Snapp's own OpenAPI document describes it. */
const pricing = (overrides: Record<string, unknown> = {}) => ({
  rateChartId: 12,
  pricingConfigId: 3,
  distanceCharged: 1_800,
  terminalsCharged: 2,
  timeFactor: 1,
  totalFare: 95_000,
  pricingId: 'pricing-abc-123',
  ...overrides,
})

// Snapp's own vocabulary, from the worked example in its specification:
// lower-case city names, and 'bike' or 'van' for the category.
const configured = () => createSnappBoxAdapter({ city: 'babol', deliveryCategory: 'bike' })

/** Typed as `fetch` is, so the recorded calls can be read back. */
function respond(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

/** The request body Snapp was actually sent. */
function sentBody(fetchMock: ReturnType<typeof respond>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Snapp Box fare adapter', () => {
  it('prices a journey against the documented endpoint', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    const quote = await configured().quoteFare(request())

    expect(quote.amount).toBe(95_000n)
    expect(quote.currency).toBe('IRR')
    // The reference the order is later created against.
    expect(quote.providerReference).toBe('pricing-abc-123')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://customer.snapp-box.com/v1/customer/order/pricing',
    )
  })

  it('sends the key verbatim, with no Bearer prefix', () => {
    // Invisible when wrong: a prefixed key comes back 401, which reads as a bad
    // credential rather than a bad header, and an operator would spend the
    // afternoon re-issuing a key that was fine.
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    return configured()
      .quoteFare(request())
      .then(() => {
        const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
        expect(headers['Authorization']).toBe('snapp-api-key')
        expect(headers['Authorization']).not.toContain('Bearer')
      })
  })

  it('sends both ends of the journey, in order, as pickup then drop-off', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await configured().quoteFare(request())

    const terminals = sentBody(fetchMock)['terminals'] as Record<string, unknown>[]
    expect(terminals).toHaveLength(2)
    expect(terminals[0]).toMatchObject({
      type: 'pickup',
      sequenceNumber: 1,
      latitude: 36.5387,
    })
    // 'drop', not 'dropoff'. Snapp's word.
    expect(terminals[1]).toMatchObject({
      type: 'drop',
      sequenceNumber: 2,
      latitude: 36.5513,
    })
  })

  it('does not hand over a customer name or phone number to price a basket', async () => {
    // Pricing runs off the coordinates. Sending real contact details for a
    // delivery nobody has ordered yet would be giving a third party a name and
    // a number on the strength of somebody looking at bread.
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await configured().quoteFare(request())

    for (const terminal of sentBody(fetchMock)['terminals'] as Record<string, unknown>[]) {
      expect(terminal['contactName']).toBe('')
      expect(terminal['contactPhoneNumber']).toBe('')
      expect(terminal['address']).toBe('')
    }
  })

  it('never asks a courier to collect cash, because this product has no such payment', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await configured().quoteFare(request())

    const body = sentBody(fetchMock)
    // 'prepaid' is Snapp's word for "billed to the account"; 'cod' is the one
    // that puts a courier at the door asking for money, and this product has
    // no such payment.
    expect(body['deliveryFarePaymentType']).toBe('prepaid')
    for (const terminal of body['terminals'] as Record<string, unknown>[]) {
      expect(terminal['cashOnDelivery']).toBe(0)
      expect(terminal['cashOnPickup']).toBe(0)
      expect(terminal['paymentType']).toBe('prepaid')
      // A string, and Snapp spells it 'no'.
      expect(terminal['collectCash']).toBe('no')
    }
  })

  it('converts Toman to Rial when the account is denominated that way', async () => {
    // Ten times wrong, on somebody's money, is what this option exists to make
    // impossible to arrive at silently.
    vi.stubGlobal('fetch', respond(pricing({ totalFare: 9_500 })))

    const quote = await createSnappBoxAdapter({
      city: 'babol',
      deliveryCategory: 'bike',
      amountUnit: 'TOMAN',
    }).quoteFare(request())

    expect(quote.amount).toBe(95_000n)
  })

  it('holds the price for a bounded window rather than indefinitely', async () => {
    vi.stubGlobal('fetch', respond(pricing()))

    const quote = await configured().quoteFare(request())

    expect(quote.expiresAt.getTime()).toBe(now.getTime() + 5 * 60_000)
  })

  it('refuses a car rather than quoting a motorcycle for it', async () => {
    // Discovered otherwise by a courier at a factory gate with a fifth of the
    // order. Our own car tariff prices it, which is correct and less cheap.
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await expect(configured().quoteFare(request({ profile: 'CAR' }))).rejects.toThrow(
      'SNAPP_BOX_VEHICLE_UNSUPPORTED',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declines to guess a city or a vehicle class Snapp alone defines', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await expect(createSnappBoxAdapter().quoteFare(request())).rejects.toThrow(
      'SNAPP_BOX_CATEGORY_NOT_CONFIGURED',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back rather than inventing a fare when the answer does not parse', async () => {
    // Every one of these is a shape surprise, and each must cost a fallback to
    // our own tariff instead of a confidently wrong number.
    for (const body of [
      pricing({ totalFare: 'nine thousand' }),
      pricing({ totalFare: 95_000.5 }),
      pricing({ pricingId: '' }),
      {},
      null,
    ]) {
      vi.stubGlobal('fetch', respond(body))
      await expect(configured().quoteFare(request())).rejects.toThrow(/SNAPP_BOX_/)
    }
  })

  it('reports the status when Snapp refuses, so an operator can tell why', async () => {
    vi.stubGlobal('fetch', respond({ message: 'forbidden' }, 403))

    await expect(configured().quoteFare(request())).rejects.toThrow('SNAPP_BOX_HTTP_403')
  })

  it('refuses an empty credential instead of calling with none', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      configured().quoteFare(
        request({ credential: { material: new TextEncoder().encode('  '), dispose: () => {} } }),
      ),
    ).rejects.toThrow('SNAPP_BOX_CREDENTIAL_MALFORMED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns no components rather than printing a rate factor as money', async () => {
    // `distanceCharged`, `terminalsCharged` and `timeFactor` are inputs to
    // Snapp's rate chart, not amounts. A breakdown built from them would show a
    // customer a multiplier labelled as Rial.
    vi.stubGlobal('fetch', respond(pricing()))

    const quote = await configured().quoteFare(request())

    expect(quote.components).toEqual([])
  })

  it('can be pointed at staging without touching the production account', async () => {
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await createSnappBoxAdapter({
      city: 'babol',
      deliveryCategory: 'bike',
      endpointOrigin: 'https://customer-stg.snapp-box.com',
    }).quoteFare(request())

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://customer-stg.snapp-box.com/v1/customer/order/pricing',
    )
  })

  it('speaks the vocabulary in the specification rather than a plausible one', async () => {
    /*
      Every value here was wrong on the first attempt at this adapter, because
      every one of them is a free string in the schema and a plausible guess is
      available for each. `SENDER` for a payment type, `DROPOFF` for the far end
      of a journey, `'false'` for a boolean-shaped string — all reasonable, all
      rejected by Snapp, and none of them visible in a type error. The worked
      example in `spec/api.yaml` is the only authority, so it is pinned here.
    */
    const fetchMock = respond(pricing())
    vi.stubGlobal('fetch', fetchMock)

    await configured().quoteFare(request())

    expect(sentBody(fetchMock)).toMatchObject({
      deliveryFarePaymentType: 'prepaid',
      customerWalletType: 'SNAPP_BOX',
      isReturn: false,
      waitingTime: 0,
      sequenceNumberDeliveryCollection: 1,
      city: 'babol',
      deliveryCategory: 'bike',
    })
  })

  it('declares the SPI version the registry checks it against', () => {
    expect(configured().spiVersion).toBe(DELIVERY_FARE_ADAPTER_SPI_VERSION)
    expect(configured().code).toBe('SNAPP_BOX')
  })
})
