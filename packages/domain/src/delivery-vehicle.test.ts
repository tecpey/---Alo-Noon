import { describe, expect, it } from 'vitest'

import {
  DEFAULT_VEHICLE_POLICY,
  deliveryVehicleOptions,
  requiredDeliveryVehicle,
  vehicleChoiceAllowed,
  vehicleSatisfies,
  type VehiclePolicy,
} from './delivery-vehicle'
import { DomainError } from './errors'

/**
 * The rule that decides whether an order goes out on a motorcycle or in a car.
 *
 * Worth testing closely because both ways of being wrong are expensive and only
 * one of them is visible. Sending a car where a motorcycle would do shows up as
 * a fare somebody queries. Sending a motorcycle where a car was needed shows up
 * as a courier at a factory gate with a fifth of the order, and by then the
 * bread is made, the slot is spent and the customer is gone.
 */
const policy: VehiclePolicy = { motorcycleItemLimit: 40, motorcycleRangeMetres: 12_000 }

describe('choosing the vehicle for an order', () => {
  it('leaves a household order on a motorcycle', () => {
    const result = requiredDeliveryVehicle({ itemCount: 4, distanceMetres: 1_800 }, policy)
    expect(result.profile).toBe('MOTORCYCLE')
    expect(result.reason).toBe('NONE')
  })

  it('sends a school’s order in a car however close the school is', () => {
    // The case the product was missing: bulk buyers next door. Distance is
    // irrelevant — three hundred loaves do not fit on a motorcycle parked
    // outside the bakery either.
    const result = requiredDeliveryVehicle({ itemCount: 300, distanceMetres: 600 }, policy)
    expect(result.profile).toBe('CAR')
    expect(result.reason).toBe('LOAD')
  })

  it('sends a small order to an industrial estate in a car anyway', () => {
    // The other missing case: two loaves to a unit on the ring road. It fits on
    // a motorcycle and still should not go on one.
    const result = requiredDeliveryVehicle({ itemCount: 2, distanceMetres: 19_000 }, policy)
    expect(result.profile).toBe('CAR')
    expect(result.reason).toBe('DISTANCE')
  })

  it('says when both reasons applied, not just the first one it found', () => {
    // A factory canteen in the next town. Reported separately because relaxing
    // either threshold alone would not change this order, and an operator
    // tuning one of them needs to know that.
    const result = requiredDeliveryVehicle({ itemCount: 400, distanceMetres: 26_000 }, policy)
    expect(result.reason).toBe('LOAD_AND_DISTANCE')
  })

  it('treats the limits as inclusive, so a full box is still a motorcycle', () => {
    // Off by one here puts every exactly-full order in a car, which is the
    // expensive direction to be wrong in by accident rather than on purpose.
    expect(requiredDeliveryVehicle({ itemCount: 40, distanceMetres: 12_000 }, policy).profile).toBe(
      'MOTORCYCLE',
    )
    expect(requiredDeliveryVehicle({ itemCount: 41, distanceMetres: 12_000 }, policy).reason).toBe(
      'LOAD',
    )
    expect(requiredDeliveryVehicle({ itemCount: 40, distanceMetres: 12_001 }, policy).reason).toBe(
      'DISTANCE',
    )
  })

  it('carries the inputs back, so a quote can explain itself', () => {
    const result = requiredDeliveryVehicle({ itemCount: 90, distanceMetres: 3_000 }, policy)
    expect(result).toMatchObject({ itemCount: 90, distanceMetres: 3_000 })
  })

  it('obeys a tenant’s own thresholds rather than the defaults', () => {
    // The defaults are stated assumptions. A tenant whose couriers ride larger
    // boxes, or whose city is bigger, must be able to say so without this file
    // changing — otherwise the number gets edited in the source and every other
    // tenant silently moves with it.
    const generous: VehiclePolicy = { motorcycleItemLimit: 120, motorcycleRangeMetres: 30_000 }
    expect(
      requiredDeliveryVehicle({ itemCount: 90, distanceMetres: 19_000 }, generous).profile,
    ).toBe('MOTORCYCLE')
  })

  it('defaults to the stated policy when none is given', () => {
    expect(requiredDeliveryVehicle({ itemCount: 41, distanceMetres: 0 }).reason).toBe('LOAD')
    expect(DEFAULT_VEHICLE_POLICY.motorcycleItemLimit).toBe(40)
    expect(DEFAULT_VEHICLE_POLICY.motorcycleRangeMetres).toBe(12_000)
  })

  it('refuses nonsense rather than quietly picking a vehicle for it', () => {
    // A negative or fractional count means a caller computed it wrongly.
    // Answering "motorcycle" would bury that in an order that then fails at the
    // gate; throwing surfaces it where it happened.
    expect(() => requiredDeliveryVehicle({ itemCount: -1, distanceMetres: 0 })).toThrow(DomainError)
    expect(() => requiredDeliveryVehicle({ itemCount: 1.5, distanceMetres: 0 })).toThrow(
      DomainError,
    )
    expect(() => requiredDeliveryVehicle({ itemCount: 1, distanceMetres: -5 })).toThrow(DomainError)
    expect(() =>
      requiredDeliveryVehicle(
        { itemCount: 1, distanceMetres: 1 },
        { motorcycleItemLimit: 0, motorcycleRangeMetres: 1 },
      ),
    ).toThrow(DomainError)
  })
})

describe('which couriers may take it', () => {
  it('lets a larger vehicle do a smaller one’s job', () => {
    // A requirement is a floor. Refusing the only free courier because they
    // brought a van would strand an order the van could plainly carry.
    expect(vehicleSatisfies('MOTORCYCLE', 'VAN')).toBe(true)
    expect(vehicleSatisfies('MOTORCYCLE', 'CAR')).toBe(true)
    expect(vehicleSatisfies('CAR', 'VAN')).toBe(true)
  })

  it('never lets a smaller one do a larger one’s', () => {
    expect(vehicleSatisfies('CAR', 'MOTORCYCLE')).toBe(false)
    expect(vehicleSatisfies('CAR', 'ELECTRIC_MOTORCYCLE')).toBe(false)
    expect(vehicleSatisfies('CAR', 'BICYCLE')).toBe(false)
  })

  it('keeps bread off bicycles and pedestrians entirely', () => {
    // Both are real VehicleType values. Neither is dispatched bread: the
    // freshness window is written assuming a powered vehicle, and a rider who
    // accepts a run they cannot finish inside it delivers stale bread that was
    // sold as fresh.
    expect(vehicleSatisfies('MOTORCYCLE', 'BICYCLE')).toBe(false)
    expect(vehicleSatisfies('MOTORCYCLE', 'ON_FOOT')).toBe(false)
  })
})

/*
 * Offering the choice rather than announcing the answer.
 *
 * Both vehicles are always shown. The one that cannot be used is shown disabled
 * with a reason, because that teaches the customer something a missing option
 * cannot: that bread does reach their village, by car.
 */
describe('what the customer may choose', () => {
  const blocked = (input: Parameters<typeof deliveryVehicleOptions>[0]) =>
    deliveryVehicleOptions(input, policy).options.find((o) => o.profile === 'MOTORCYCLE')!

  it('offers both when nothing stands in the way', () => {
    const choice = deliveryVehicleOptions({ itemCount: 4, distanceMetres: 1_800 }, policy)
    expect(choice.options.map((o) => [o.profile, o.available])).toEqual([
      ['MOTORCYCLE', true],
      ['CAR', true],
    ])
    expect(choice.fallback).toBe('MOTORCYCLE')
  })

  it('never blocks the car, so nobody is offered nothing', () => {
    // The state that matters most for the addresses this exists to serve: a
    // village loses the motorcycle and must not lose the order with it.
    const choice = deliveryVehicleOptions(
      { itemCount: 900, distanceMetres: 80_000, motorcycleAllowedInArea: false },
      policy,
    )
    expect(choice.options.find((o) => o.profile === 'CAR')).toEqual({
      profile: 'CAR',
      available: true,
    })
    expect(choice.fallback).toBe('CAR')
  })

  it('disables the motorcycle for an area that does not take them', () => {
    // Not arithmetic: eight kilometres is inside the range, and the far side of
    // a river with one bridge is still nowhere to send a loaded motorcycle.
    expect(
      blocked({ itemCount: 3, distanceMetres: 8_000, motorcycleAllowedInArea: false }),
    ).toEqual({ profile: 'MOTORCYCLE', available: false, blockedBy: 'AREA' })
  })

  it('reports the area ahead of the thresholds, because only it is final', () => {
    // A smaller basket fixes LOAD and a nearer address fixes DISTANCE. An area
    // that refuses motorcycles refuses them at any size, so telling somebody
    // their basket is too big would send them to shrink it for nothing.
    expect(
      blocked({ itemCount: 900, distanceMetres: 90_000, motorcycleAllowedInArea: false })
        ?.blockedBy,
    ).toBe('AREA')
  })

  it('treats an area that permits them as no obstacle at all', () => {
    expect(
      blocked({ itemCount: 3, distanceMetres: 1_000, motorcycleAllowedInArea: true }).available,
    ).toBe(true)
  })

  it('defaults to permitting them when the area says nothing', () => {
    // Every area predates the flag, and every one of them allowed motorcycles.
    expect(blocked({ itemCount: 3, distanceMetres: 1_000 }).available).toBe(true)
  })

  it('falls back to the cheapest option that is actually available', () => {
    expect(deliveryVehicleOptions({ itemCount: 4, distanceMetres: 100 }, policy).fallback).toBe(
      'MOTORCYCLE',
    )
    expect(deliveryVehicleOptions({ itemCount: 4, distanceMetres: 99_000 }, policy).fallback).toBe(
      'CAR',
    )
  })
})

describe('checking a choice the customer sent', () => {
  it('refuses a motorcycle the order cannot use', () => {
    // The interface disabling the option is a courtesy; this is the
    // enforcement. Somebody who edits the request must not get a motorcycle
    // fare for four hundred loaves.
    const choice = deliveryVehicleOptions({ itemCount: 400, distanceMetres: 500 }, policy)
    expect(vehicleChoiceAllowed(choice, 'MOTORCYCLE')).toBe(false)
    expect(vehicleChoiceAllowed(choice, 'CAR')).toBe(true)
  })

  it('allows a car even when a motorcycle would have done', () => {
    // Choosing the dearer vehicle is always the customer's to make — they may
    // want it out of the rain.
    const choice = deliveryVehicleOptions({ itemCount: 2, distanceMetres: 500 }, policy)
    expect(vehicleChoiceAllowed(choice, 'CAR')).toBe(true)
    expect(vehicleChoiceAllowed(choice, 'MOTORCYCLE')).toBe(true)
  })
})

describe('the single answer, for callers that want one', () => {
  it('reports an area refusal as DISTANCE, which is what a quote can record', () => {
    // AREA describes where the order is going; the quote's reasons describe the
    // order. "A motorcycle does not come out this far" is the truthful summary.
    expect(
      requiredDeliveryVehicle(
        { itemCount: 2, distanceMetres: 3_000, motorcycleAllowedInArea: false },
        policy,
      ),
    ).toMatchObject({ profile: 'CAR', reason: 'DISTANCE' })
  })
})
