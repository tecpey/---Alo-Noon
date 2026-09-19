import { describe, expect, it } from 'vitest'

import {
  applyFareMultiplier,
  createDeliveryFareRegistry,
  DEFAULT_DYNAMIC_FARE_POLICY,
  DELIVERY_FARE_ADAPTER_SPI_VERSION,
  dynamicFareMultiplier,
  FARE_MULTIPLIER_ONE,
  minuteOfLocalDay,
  normalizeProviderFareQuote,
  roundFareToStep,
  type DeliveryFareProvider,
  type DynamicFarePolicy,
  type ProviderFareQuote,
} from './delivery-fare'
import { DomainError } from './errors'

const adapter = (overrides: Partial<DeliveryFareProvider> = {}): DeliveryFareProvider => ({
  code: 'TESTFARE',
  adapterVersion: '1.0.0',
  spiVersion: DELIVERY_FARE_ADAPTER_SPI_VERSION,
  quoteFare: async () => {
    throw new Error('unused')
  },
  ...overrides,
})

const now = new Date('2026-09-19T05:00:00.000Z')
const quote = (overrides: Partial<ProviderFareQuote> = {}): ProviderFareQuote => ({
  amount: 250_000n,
  currency: 'IRR',
  expiresAt: new Date(now.getTime() + 300_000),
  providerReference: 'fare-abc-123',
  ...overrides,
})

describe('delivery fare registry', () => {
  it('resolves an adapter by code, version and SPI version together', () => {
    const registry = createDeliveryFareRegistry([adapter()])
    expect(
      registry.resolve({
        providerCode: 'TESTFARE',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
      }).code,
    ).toBe('TESTFARE')
  })

  it('refuses a configuration naming a version this build does not carry', () => {
    const registry = createDeliveryFareRegistry([adapter()])
    expect(() =>
      registry.resolve({
        providerCode: 'TESTFARE',
        adapterVersion: '2.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
      }),
    ).toThrow(DomainError)
  })

  it('keeps a test-only adapter away from production pricing', () => {
    const registry = createDeliveryFareRegistry([adapter({ testOnly: true })])
    const input = {
      providerCode: 'TESTFARE',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
    } as const
    expect(registry.resolve({ ...input, environment: 'TEST' }).code).toBe('TESTFARE')
    expect(() => registry.resolve({ ...input, environment: 'PRODUCTION' })).toThrow(DomainError)
  })

  it('rejects a duplicated identity rather than letting one shadow the other', () => {
    expect(() => createDeliveryFareRegistry([adapter(), adapter()])).toThrow(DomainError)
  })
})

describe('provider fare validation', () => {
  it('accepts a well-formed quote unchanged', () => {
    const normalized = normalizeProviderFareQuote(quote(), now)
    expect(normalized.amount).toBe(250_000n)
    expect(normalized.providerReference).toBe('fare-abc-123')
  })

  it('refuses a fare that would credit the customer', () => {
    expect(() => normalizeProviderFareQuote(quote({ amount: -1n }), now)).toThrow(DomainError)
  })

  it('refuses a quote that has already expired', () => {
    // A provider answering with a stale window would make every order re-quote
    // forever; better to fall back to our own tariff than to loop.
    expect(() =>
      normalizeProviderFareQuote(quote({ expiresAt: new Date(now.getTime() - 1) }), now),
    ).toThrow(DomainError)
  })

  it('refuses a quote with no usable reference to book against', () => {
    expect(() => normalizeProviderFareQuote(quote({ providerReference: '' }), now)).toThrow(
      DomainError,
    )
  })
})

describe('dynamic fare multiplier', () => {
  const policy = DEFAULT_DYNAMIC_FARE_POLICY

  it('leaves an ordinary hour at exactly one', () => {
    const decision = dynamicFareMultiplier(policy, 11 * 60)
    expect(decision.basisPoints).toBe(FARE_MULTIPLIER_ONE)
    expect(decision.reasons).toEqual([])
  })

  it('raises the breakfast rush and says so in Persian', () => {
    const decision = dynamicFareMultiplier(policy, 7 * 60 + 30)
    expect(decision.basisPoints).toBe(11_500)
    expect(decision.reasons[0]?.labelFa).toBe('شلوغی صبحگاهی')
  })

  it('treats a window as half-open so its last minute belongs to one side only', () => {
    expect(dynamicFareMultiplier(policy, 6 * 60).basisPoints).toBe(11_500)
    expect(dynamicFareMultiplier(policy, 9 * 60).basisPoints).toBe(FARE_MULTIPLIER_ONE)
  })

  it('ignores demand entirely while demand pricing is off', () => {
    const decision = dynamicFareMultiplier(policy, 11 * 60, {
      openOrders: 90,
      availableCouriers: 1,
    })
    expect(decision.basisPoints).toBe(FARE_MULTIPLIER_ONE)
  })

  it('adds demand to the peak rather than compounding with it', () => {
    const withDemand: DynamicFarePolicy = { ...policy, demandEnabled: true }
    // Five orders per courier against a threshold of three: two steps of 500.
    const decision = dynamicFareMultiplier(withDemand, 7 * 60, {
      openOrders: 10,
      availableCouriers: 2,
    })
    expect(decision.basisPoints).toBe(11_500 + 1_000)
    expect(decision.capped).toBe(false)
  })

  it('does not surcharge an ordinary load', () => {
    const withDemand: DynamicFarePolicy = { ...policy, demandEnabled: true }
    const decision = dynamicFareMultiplier(withDemand, 11 * 60, {
      openOrders: 6,
      availableCouriers: 2,
    })
    expect(decision.basisPoints).toBe(FARE_MULTIPLIER_ONE)
  })

  it('caps whatever the signals say, and reports that it did', () => {
    const withDemand: DynamicFarePolicy = { ...policy, demandEnabled: true }
    const decision = dynamicFareMultiplier(withDemand, 7 * 60, {
      openOrders: 200,
      availableCouriers: 1,
    })
    expect(decision.basisPoints).toBe(policy.maxMultiplierBasisPoints)
    expect(decision.capped).toBe(true)
  })

  it('treats no available couriers as a capacity problem, not infinite demand', () => {
    const withDemand: DynamicFarePolicy = { ...policy, demandEnabled: true }
    const decision = dynamicFareMultiplier(withDemand, 11 * 60, {
      openOrders: 40,
      availableCouriers: 0,
    })
    expect(decision.basisPoints).toBe(FARE_MULTIPLIER_ONE)
  })

  it('rejects a policy whose cap is below one', () => {
    expect(() =>
      dynamicFareMultiplier({ ...policy, maxMultiplierBasisPoints: 9_000 }, 11 * 60),
    ).toThrow(DomainError)
  })
})

describe('applying a multiplier to money', () => {
  it('rounds to the nearest hundred Toman rather than quoting a formula', () => {
    // 50,000 × 1.15 = 57,500, which is 5,750 Toman — half a step off, so it
    // settles on 5,800.
    const decision = dynamicFareMultiplier(DEFAULT_DYNAMIC_FARE_POLICY, 7 * 60)
    expect(applyFareMultiplier(50_000n, decision).amount).toBe(58_000n)
    // 55,000 × 1.15 = 63,250, which is not a price anybody writes down.
    expect(applyFareMultiplier(55_000n, decision).amount).toBe(63_000n)
  })

  it('rounds to nearest rather than upward, so rounding is not a surcharge', () => {
    expect(roundFareToStep(63_499n)).toBe(63_000n)
    expect(roundFareToStep(63_500n)).toBe(64_000n)
    expect(roundFareToStep(63_501n)).toBe(64_000n)
  })

  it('keeps free delivery free through the busiest hour', () => {
    const decision = dynamicFareMultiplier(DEFAULT_DYNAMIC_FARE_POLICY, 7 * 60)
    expect(applyFareMultiplier(0n, decision)).toEqual({ amount: 0n, uplift: 0n })
  })

  it('reports the uplift separately so a quote can show what moved', () => {
    const decision = dynamicFareMultiplier(DEFAULT_DYNAMIC_FARE_POLICY, 7 * 60)
    expect(applyFareMultiplier(50_000n, decision).uplift).toBe(8_000n)
  })
})

describe('local time', () => {
  it('reads Tehran time rather than the server clock', () => {
    // 03:30 UTC is 07:00 in Tehran — inside the breakfast window, and outside
    // it by UTC, which is exactly the mistake this exists to prevent.
    const at = new Date('2026-09-19T03:30:00.000Z')
    expect(minuteOfLocalDay(at, 'Asia/Tehran')).toBe(7 * 60)
    expect(minuteOfLocalDay(at, 'UTC')).toBe(3 * 60 + 30)
  })

  it('places midnight at zero rather than at 1440', () => {
    const at = new Date('2026-09-18T20:30:00.000Z')
    expect(minuteOfLocalDay(at, 'Asia/Tehran')).toBe(0)
  })
})
