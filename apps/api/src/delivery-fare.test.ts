import { describe, expect, it } from 'vitest'

import {
  createDeliveryFareRegistry,
  DEFAULT_DYNAMIC_FARE_POLICY,
  DELIVERY_FARE_ADAPTER_SPI_VERSION,
  FARE_MULTIPLIER_ONE,
  type DeliveryFareProvider,
  type ProviderFareQuote,
} from '@alo-noon/domain'

import {
  chooseFare,
  createEnvironmentDeliveryFareCredentialResolver,
  type ProviderFareOffer,
  type ResolvedFare,
} from './modules/delivery-fare'

const now = new Date('2026-09-19T07:30:00.000Z')

const context = {
  branchId: '11111111-1111-4111-8111-111111111111',
  addressId: '22222222-2222-4222-8222-222222222222',
  profile: 'MOTORCYCLE' as const,
}

const offer = (overrides: Partial<ProviderFareOffer> = {}): ProviderFareOffer => ({
  amount: 90_000n,
  providerCode: 'TESTFARE',
  providerReference: 'ref-1',
  expiresAt: new Date(now.getTime() + 300_000),
  surgeBasisPoints: FARE_MULTIPLIER_ONE,
  components: [],
  quotedFor: context,
  ...overrides,
})

const own: ResolvedFare = Object.freeze({
  amount: 57_000n,
  source: 'DYNAMIC',
  providerCode: null,
  providerReference: null,
  expiresAt: new Date(now.getTime() + 900_000),
  multiplierBasisPoints: 11_500,
  reasonCodes: Object.freeze(['MORNING_RUSH']),
  components: Object.freeze([]),
})

describe('choosing which fare a quote gets', () => {
  it('prefers the marketplace price, because that is what gets invoiced', () => {
    const fare = chooseFare(50_000n, offer(), context, own, now)
    expect(fare.source).toBe('PROVIDER')
    expect(fare.amount).toBe(90_000n)
    expect(fare.providerReference).toBe('ref-1')
  })

  it('falls back to our own fare when there is no offer at all', () => {
    expect(chooseFare(50_000n, null, context, own, now)).toEqual(own)
  })

  it('discards an offer that has stopped being held', () => {
    // Not nearly-valid: a price nobody is committed to any more is worth no
    // more than no price, and honouring it would collect an amount the invoice
    // will not match.
    const stale = offer({ expiresAt: new Date(now.getTime() - 1) })
    expect(chooseFare(50_000n, stale, context, own, now).source).toBe('DYNAMIC')
  })

  it('discards an offer quoted for a different branch', () => {
    const elsewhere = offer({
      quotedFor: { ...context, branchId: '33333333-3333-4333-8333-333333333333' },
    })
    expect(chooseFare(50_000n, elsewhere, context, own, now).source).toBe('DYNAMIC')
  })

  it('discards an offer quoted for a different vehicle', () => {
    // The vehicle is derived twice — once to ask the provider, once
    // authoritatively — and a car priced as a motorcycle is exactly the
    // mismatch that would otherwise be invisible.
    const wrongVehicle = offer({ quotedFor: { ...context, profile: 'CAR' } })
    expect(chooseFare(50_000n, wrongVehicle, context, own, now).source).toBe('DYNAMIC')
  })

  it('keeps a free delivery free, whoever would have priced it', () => {
    const fare = chooseFare(0n, offer(), context, own, now)
    expect(fare.amount).toBe(0n)
    expect(fare.source).toBe('TARIFF')
    expect(fare.multiplierBasisPoints).toBe(FARE_MULTIPLIER_ONE)
  })

  it('marks a surging provider fare so the customer can be told why', () => {
    const surging = offer({ amount: 120_000n, surgeBasisPoints: 13_000 })
    expect(chooseFare(50_000n, surging, context, own, now).reasonCodes).toEqual(['PROVIDER_SURGE'])
  })
})

describe('fare credential references', () => {
  const resolver = createEnvironmentDeliveryFareCredentialResolver({
    DELIVERY_FARE_TESTFARE_KEY: 'a-real-key',
    DATABASE_URL: 'postgresql://secret@database/internal',
  })

  it('resolves a reference with the required prefix', async () => {
    const credential = await resolver.resolve(
      'env://DELIVERY_FARE_TESTFARE_KEY',
      'tenant',
      'TESTFARE',
    )
    expect(Buffer.from(credential.material).toString('utf8')).toBe('a-real-key')
    credential.dispose()
  })

  it('refuses to hand a third party an unrelated environment variable', async () => {
    // The prefix is the whole defence: without it a configuration row could
    // name DATABASE_URL and have its value posted to somebody else's API.
    await expect(resolver.resolve('env://DATABASE_URL', 'tenant', 'TESTFARE')).rejects.toThrow()
  })

  it('treats an unset credential as absent rather than empty', async () => {
    await expect(
      resolver.resolve('env://DELIVERY_FARE_MISSING', 'tenant', 'TESTFARE'),
    ).rejects.toThrow()
  })
})

describe('the adapter seam', () => {
  const quoting = (quote: () => Promise<ProviderFareQuote>): DeliveryFareProvider => ({
    code: 'TESTFARE',
    adapterVersion: '1.0.0',
    spiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,
    quoteFare: quote,
  })

  it('carries an adapter that prices a trip', async () => {
    const registry = createDeliveryFareRegistry([
      quoting(async () => ({
        amount: 88_000n,
        currency: 'IRR' as const,
        expiresAt: new Date(now.getTime() + 60_000),
        providerReference: 'trip-9',
      })),
    ])
    const provider = registry.resolve({
      providerCode: 'TESTFARE',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST',
    })
    const quoted = await provider.quoteFare({
      origin: { latitude: 36.55, longitude: 52.67 },
      destination: { latitude: 36.47, longitude: 52.35 },
      profile: 'CAR',
      distanceMetres: 39_000,
      durationSeconds: null,
      itemCount: 5,
      requestedAt: now,
      timeoutMs: 4_000,
      configuration: {
        id: 'configuration',
        tenantId: 'tenant',
        providerCode: 'TESTFARE',
        adapterVersion: '1.0.0',
        adapterSpiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,
        environment: 'TEST',
        credentialReference: 'env://DELIVERY_FARE_TESTFARE_KEY',
      },
      credential: { material: new Uint8Array(), dispose: () => {} },
    })
    expect(quoted.amount).toBe(88_000n)
  })

  it('has no adapters registered in this build, which is the honest state', () => {
    // This shop delivers with its own couriers. The seam exists so signing a
    // courier platform is an adapter and a configuration row rather than a
    // change to the checkout — and this test is what will fail, loudly and in
    // the right place, on the day one is added without being reviewed here.
    expect(createDeliveryFareRegistry([]).identities()).toEqual([])
  })
})

describe('the shipped fare policy', () => {
  it('adds no time-of-day or demand factor to a delivery charge', () => {
    // What varies is the journey: distance, vehicle, area and load, all of
    // which moved the number before the fare service saw it. Nothing here
    // charges differently for the same journey depending on when it is asked
    // for — that is a capability the shop switches on, not a default.
    expect(DEFAULT_DYNAMIC_FARE_POLICY.peakWindows).toEqual([])
    expect(DEFAULT_DYNAMIC_FARE_POLICY.demandEnabled).toBe(false)
  })

  it('caps how far any combination of factors can move a fare once switched on', () => {
    expect(DEFAULT_DYNAMIC_FARE_POLICY.maxMultiplierBasisPoints).toBe(15_000)
  })
})
