import { describe, expect, it } from 'vitest'

import {
  DEFAULT_VEHICLE_POLICY,
  requiredDeliveryVehicle,
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
