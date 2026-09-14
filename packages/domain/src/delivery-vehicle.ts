import { DomainError } from './errors'
import type { RoutingProfile } from './routing'

/**
 * Whether this order needs a car, and why.
 *
 * Until now every delivery was assumed to be a motorcycle. That assumption is
 * fine for the order it was written for — a household buying breakfast from the
 * bakery down the road — and wrong for two kinds of customer the product is
 * meant to serve:
 *
 * **The bulk buyer.** A school, an office, a factory canteen, a production unit
 * ordering bread by the hundred. It does not matter how close they are; it does
 * not fit on a motorcycle, and a courier who accepts it either crushes it or
 * makes three trips nobody priced.
 *
 * **The distant buyer.** Industrial estates on the ring road, units outside the
 * city, customers in surrounding towns. A motorcycle can physically get there
 * and should not: it is an hour each way in Mazandaran weather, on roads a
 * motorcycle has no business doing at speed, for one delivery.
 *
 * So the vehicle is **derived, not chosen**. A customer is told what their
 * order requires, rather than asked — asking invites the answer that is cheaper
 * and wrong, and the person who finds out is the courier holding four hundred
 * loaves at a factory gate.
 *
 * ## On the thresholds
 *
 * They are stated assumptions, not measurements, and they are deliberately
 * parameters rather than constants so a tenant can correct them without this
 * file changing. The defaults below are the honest starting point and should be
 * replaced by the first month of real orders — the data needed to do it is a
 * count of deliveries that needed a second trip against their item count.
 *
 * Both thresholds err towards the car. Sending a car where a motorcycle would
 * have done costs the difference in fare on one order. Sending a motorcycle
 * where a car was needed costs the order, the bread, and the customer.
 */

/** What tipped the decision. Ordered by how it should be explained. */
export type VehicleRequirementReason =
  /** Too many items for one motorcycle box, whatever the distance. */
  | 'LOAD'
  /** Far enough that a motorcycle is the wrong tool, whatever the load. */
  | 'DISTANCE'
  /** Both independently required it. Worth distinguishing: relaxing one
      threshold would not change this order's answer. */
  | 'LOAD_AND_DISTANCE'
  /** A motorcycle is right. */
  | 'NONE'

export interface VehicleRequirement {
  readonly profile: RoutingProfile
  readonly reason: VehicleRequirementReason
  /** The inputs, carried so a quote can explain itself without recomputing. */
  readonly itemCount: number
  readonly distanceMetres: number
}

export interface VehiclePolicy {
  /**
   * The most items one motorcycle can carry in a single run.
   *
   * Item count rather than weight or volume because the catalogue records
   * neither — a variant has a packaging type and a shelf life, and nothing that
   * says how much room it takes. For bread this is a fair proxy: the products
   * are within an order of magnitude of one another in bulk, which is not true
   * of a general goods catalogue and would stop being true the day this shop
   * sells sacks of flour. When that happens, this is the thing to replace.
   */
  readonly motorcycleItemLimit: number
  /**
   * Beyond this, a car regardless of how little is being carried.
   *
   * Sized for the geography this serves rather than for a general rule: a
   * Mazandaran city is a few kilometres across, the industrial estates sit on
   * the ring roads beyond it, and the surrounding towns are further again. The
   * number is meant to fall between the last address that is properly in town
   * and the first one that is not.
   */
  readonly motorcycleRangeMetres: number
}

/**
 * Defaults, and the reasoning rather than the arithmetic.
 *
 * Forty items: a courier's top box and panniers hold roughly that many packaged
 * loaves before the load starts riding badly. Chosen at the low end of what
 * looks carryable, because the cost of being wrong is asymmetric.
 *
 * Twelve kilometres: past the far edge of a Mazandaran city and its ring road,
 * short of the neighbouring towns. An address beyond it is an estate, a
 * factory, or another town — all three of which are car journeys.
 */
export const DEFAULT_VEHICLE_POLICY: VehiclePolicy = Object.freeze({
  motorcycleItemLimit: 40,
  motorcycleRangeMetres: 12_000,
})

export function requiredDeliveryVehicle(
  input: { itemCount: number; distanceMetres: number },
  policy: VehiclePolicy = DEFAULT_VEHICLE_POLICY,
): Readonly<VehicleRequirement> {
  const { itemCount, distanceMetres } = input
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new DomainError('INVALID_VEHICLE_INPUT', 'Item count is invalid')
  }
  if (!Number.isSafeInteger(distanceMetres) || distanceMetres < 0) {
    throw new DomainError('INVALID_VEHICLE_INPUT', 'Distance is invalid')
  }
  if (policy.motorcycleItemLimit < 1 || policy.motorcycleRangeMetres < 1) {
    throw new DomainError('INVALID_VEHICLE_POLICY', 'Vehicle policy thresholds must be positive')
  }

  // Strictly greater: a policy that says forty fit on a motorcycle means forty
  // fit on a motorcycle. Off-by-one here would put every full-box order in a
  // car, which is the expensive direction to be wrong in by accident.
  const overloaded = itemCount > policy.motorcycleItemLimit
  const tooFar = distanceMetres > policy.motorcycleRangeMetres

  const reason: VehicleRequirementReason =
    overloaded && tooFar ? 'LOAD_AND_DISTANCE' : overloaded ? 'LOAD' : tooFar ? 'DISTANCE' : 'NONE'

  return Object.freeze({
    profile: (reason === 'NONE' ? 'MOTORCYCLE' : 'CAR') satisfies RoutingProfile,
    reason,
    itemCount,
    distanceMetres,
  })
}

/**
 * Which vehicles can actually serve a requirement.
 *
 * A requirement is a floor, not an exact match: a van can do a car's job, and
 * on the day a courier with a van is the only one free, refusing them because
 * the order said "car" would strand it. The reverse is never true — nothing
 * smaller substitutes for a car, which is the whole point of deriving this.
 *
 * Bicycles and on-foot couriers are omitted from the motorcycle tier
 * deliberately. They are real `VehicleType` values and this product does not
 * dispatch bread to them: the freshness window assumes a powered vehicle.
 */
export const VEHICLES_SATISFYING: Readonly<Record<RoutingProfile, readonly string[]>> =
  Object.freeze({
    MOTORCYCLE: Object.freeze(['MOTORCYCLE', 'ELECTRIC_MOTORCYCLE', 'CAR', 'VAN']),
    CAR: Object.freeze(['CAR', 'VAN']),
  })

/** Whether a courier's vehicle is allowed to take an order needing `profile`. */
export function vehicleSatisfies(profile: RoutingProfile, vehicleType: string): boolean {
  return VEHICLES_SATISFYING[profile].includes(vehicleType)
}
