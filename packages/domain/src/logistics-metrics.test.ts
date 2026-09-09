import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  batchDensity,
  cacheHitRate,
  deliveryEconomics,
  deliveryFailureRate,
  measuredDetourFactor,
  routedShare,
} from './logistics-metrics'
import { URBAN_DETOUR_FACTOR } from './routing'

describe('the delivery failure rate', () => {
  it('is failures over deliveries that reached a verdict', () => {
    expect(deliveryFailureRate({ delivered: 90, failed: 10, cancelled: 0, inFlight: 0 })).toBe(0.1)
  })

  it('does not count a customer cancelling as a courier failing', () => {
    // Otherwise a good week of trading reads as a bad week of couriering, and
    // the number an operator would act on is the wrong one.
    const withoutCancellations = deliveryFailureRate({
      delivered: 90,
      failed: 10,
      cancelled: 0,
      inFlight: 0,
    })
    const withCancellations = deliveryFailureRate({
      delivered: 90,
      failed: 10,
      cancelled: 50,
      inFlight: 0,
    })

    expect(withCancellations).toBe(withoutCancellations)
  })

  it('does not let work still in flight drag the rate around', () => {
    // A rate that sank through the afternoon and recovered each evening would
    // be unreadable, and would look like a daily incident that never happened.
    expect(deliveryFailureRate({ delivered: 9, failed: 1, cancelled: 0, inFlight: 40 })).toBe(0.1)
  })

  it('says nothing rather than "no failures" when nothing has settled', () => {
    expect(deliveryFailureRate({ delivered: 0, failed: 0, cancelled: 3, inFlight: 7 })).toBeNull()
  })

  it('reports a total washout as one, not as an error', () => {
    expect(deliveryFailureRate({ delivered: 0, failed: 4, cancelled: 0, inFlight: 0 })).toBe(1)
  })

  it('refuses a negative count rather than reporting a negative rate', () => {
    expect(() =>
      deliveryFailureRate({ delivered: -1, failed: 0, cancelled: 0, inFlight: 0 }),
    ).toThrow(DomainError)
  })
})

describe('batch density', () => {
  it('is one while every run carries a single order', () => {
    // The baseline batching has to beat. Publishing it before batching exists
    // is what makes the first batched week visibly better.
    expect(batchDensity({ runs: 120, deliveries: 120 })).toBe(1)
  })

  it('rises as runs start carrying more than one drop', () => {
    expect(batchDensity({ runs: 40, deliveries: 94 })).toBe(2.35)
  })

  it('says nothing when no courier went out', () => {
    expect(batchDensity({ runs: 0, deliveries: 0 })).toBeNull()
  })
})

describe('delivery economics', () => {
  const totals = { feeAmount: 3_000_000n, distanceMetres: 60_000, deliveries: 60 }

  it('reports what was charged per delivery and per kilometre', () => {
    expect(deliveryEconomics(totals)).toEqual({
      feePerDelivery: 50_000n,
      feePerKilometre: 50_000n,
      metresPerDelivery: 1_000,
    })
  })

  it('rounds down, so an average never reads higher than what was taken', () => {
    const result = deliveryEconomics({ feeAmount: 100n, distanceMetres: 3_000, deliveries: 3 })
    expect(result.feePerDelivery).toBe(33n)
  })

  it('keeps the money in bigint the whole way', () => {
    // A tenant with a year of trading exceeds what a JavaScript number holds
    // exactly, and an average that silently lost precision would be believed.
    const huge = deliveryEconomics({
      feeAmount: 90_071_992_547_409_930n,
      distanceMetres: 2_000,
      deliveries: 2,
    })
    expect(huge.feePerDelivery).toBe(45_035_996_273_704_965n)
  })

  it('reports no rate rather than dividing by a rounded-away kilometre', () => {
    const shortHops = deliveryEconomics({ feeAmount: 500_000n, distanceMetres: 400, deliveries: 4 })
    expect(shortHops.feePerKilometre).toBeNull()
    expect(shortHops.feePerDelivery).toBe(125_000n)
  })

  it('says nothing at all when nothing was delivered', () => {
    expect(deliveryEconomics({ feeAmount: 0n, distanceMetres: 0, deliveries: 0 })).toEqual({
      feePerDelivery: null,
      feePerKilometre: null,
      metresPerDelivery: null,
    })
  })

  it('refuses a negative fee total', () => {
    expect(() => deliveryEconomics({ feeAmount: -1n, distanceMetres: 10, deliveries: 1 })).toThrow(
      DomainError,
    )
  })
})

describe('routing coverage', () => {
  it('is the share of fares the engine actually measured', () => {
    expect(routedShare({ routed: 900, estimated: 100, unattributed: 0 })).toBe(0.9)
  })

  it('does not count pre-routing quotes as an outage', () => {
    // Those were priced on an unscaled straight line by a version with no
    // concept of provenance. Folding them in would make a historical range look
    // like a routing incident that never happened.
    expect(routedShare({ routed: 10, estimated: 0, unattributed: 5_000 })).toBe(1)
  })

  it('says nothing for a range with no attributed quotes at all', () => {
    expect(routedShare({ routed: 0, estimated: 0, unattributed: 12 })).toBeNull()
  })
})

describe('the measured detour factor', () => {
  it('averages the per-delivery ratio, not the ratio of the totals', () => {
    // One long run must not outvote a hundred short ones: the fallback is
    // applied to a single delivery, so the average has to be over deliveries.
    const samples = [
      { routedMetres: 1_300, straightLineMetres: 1_000 },
      { routedMetres: 2_000, straightLineMetres: 1_000 },
    ]

    expect(measuredDetourFactor(samples)).toBe(1.65)
    // The ratio of the sums would have been 3300/2000 = 1.65 here by
    // coincidence of equal baselines; the next case separates them.
    expect(
      measuredDetourFactor([
        { routedMetres: 1_100, straightLineMetres: 1_000 },
        { routedMetres: 30_000, straightLineMetres: 10_000 },
      ]),
    ).toBe(2.05)
  })

  it('drops a delivery with no straight line to compare against', () => {
    expect(
      measuredDetourFactor([
        { routedMetres: 0, straightLineMetres: 0 },
        { routedMetres: 1_400, straightLineMetres: 1_000 },
      ]),
    ).toBe(1.4)
  })

  it('says nothing when there is nothing to measure', () => {
    expect(measuredDetourFactor([])).toBeNull()
    expect(measuredDetourFactor([{ routedMetres: 500, straightLineMetres: 0 }])).toBeNull()
  })

  it('is comparable against the assumption it exists to replace', () => {
    // Not an assertion about the world — an assertion that the two numbers are
    // the same kind of number, so an operator can read one off a report and put
    // it where the other is.
    const measured = measuredDetourFactor([{ routedMetres: 1_300, straightLineMetres: 1_000 }])
    expect(measured).toBe(URBAN_DETOUR_FACTOR)
  })
})

describe('the routing cache hit rate', () => {
  it('is hits over everything asked for', () => {
    expect(cacheHitRate(750, 250)).toBe(0.75)
  })

  it('says nothing before anything has been asked', () => {
    expect(cacheHitRate(0, 0)).toBeNull()
  })

  it('refuses a negative count', () => {
    expect(() => cacheHitRate(-1, 0)).toThrow(DomainError)
  })
})
