import { describe, expect, it } from 'vitest'

import {
  assertTripIsDeliverable,
  DeliveryTripState,
  MAX_TRIP_DROPS,
  planTrip,
  transitionDeliveryTrip,
  tripAcceptsChanges,
  type BatchCandidate,
} from './delivery-batching'
import { DomainError } from './errors'

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const DEPART = new Date('2026-08-26T09:00:00.000Z')

/** Roughly 111 metres north per 0.001 of latitude, which keeps the sums readable. */
function north(metres: number) {
  return { latitude: BRANCH.latitude + metres / 111_000, longitude: BRANCH.longitude }
}
function east(metres: number) {
  return { latitude: BRANCH.latitude, longitude: BRANCH.longitude + metres / 89_000 }
}

function candidate(
  taskId: string,
  destination: { latitude: number; longitude: number },
  overrides: Partial<BatchCandidate> = {},
): BatchCandidate {
  return {
    taskId,
    branchId: 'branch-1',
    destination,
    deliverBefore: null,
    readyAt: null,
    ...overrides,
  }
}

describe('planning a run', () => {
  it('always carries the order it was built around', () => {
    const anchor = candidate('anchor', north(1_000))

    const plan = planTrip(BRANCH, anchor, [], DEPART)

    // Batching helps an order that already needs delivering; it never holds one
    // back while a companion is looked for.
    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor'])
    expect(plan.stops[0]?.sequence).toBe(1)
    // A solo run saves nothing, and saying so is more useful than a flattering
    // number.
    expect(plan.savedMetres).toBe(0)
  })

  it('picks up a near neighbour and reports what that saved', () => {
    const anchor = candidate('anchor', north(1_000))
    const neighbour = candidate('neighbour', north(1_100))

    const plan = planTrip(BRANCH, anchor, [neighbour], DEPART)

    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor', 'neighbour'])
    // Two solo round trips are about 4,200 metres of riding; one loop covering
    // both is about 2,200. The saving is the whole reason batching exists.
    expect(plan.savedMetres).toBeGreaterThan(1_800)
    expect(plan.totalMetres).toBeLessThan(1_500)
  })

  it('takes a drop that lies on the way home, however far back it is', () => {
    const anchor = candidate('anchor', north(2_000))
    const onTheWayBack = candidate('on-the-way', north(500))

    const plan = planTrip(BRANCH, anchor, [onTheWayBack], DEPART)

    // 1,500 metres back toward the bakery looks like a long detour and costs
    // nothing at all: the courier rides past the door anyway. A rule that
    // measured only the outbound leg would refuse exactly the drops worth
    // taking.
    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor', 'on-the-way'])
    expect(plan.savedMetres).toBeGreaterThan(900)
  })

  it('refuses a drop that would ride too far out of the way', () => {
    const anchor = candidate('anchor', north(1_000))
    const acrossTown = candidate('across-town', east(9_000))

    const plan = planTrip(BRANCH, anchor, [acrossTown], DEPART)

    // Within nobody's deadline and still refused: a rider sent across town and
    // back inside the promise is a rider who will not take the next job.
    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor'])
  })

  it('refuses a drop that would arrive after it was promised', () => {
    const anchor = candidate('anchor', north(1_000))
    const urgent = candidate('urgent', north(1_100), {
      deliverBefore: new Date(DEPART.getTime() + 60_000),
    })

    const plan = planTrip(BRANCH, anchor, [urgent], DEPART)

    // Near enough on the map, impossible in the minutes available. The order
    // goes out on its own rather than going out late.
    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor'])
  })

  it('takes a drop whose deadline the plan comfortably makes', () => {
    const anchor = candidate('anchor', north(1_000))
    const relaxed = candidate('relaxed', north(1_100), {
      deliverBefore: new Date(DEPART.getTime() + 60 * 60_000),
    })

    const plan = planTrip(BRANCH, anchor, [relaxed], DEPART)

    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor', 'relaxed'])
    expect(plan.stops[1]!.plannedArrival.getTime()).toBeLessThan(relaxed.deliverBefore!.getTime())
  })

  it('does not let a nearby refusal block a slightly further acceptance', () => {
    const anchor = candidate('anchor', north(1_000))
    // Nearer, but promised in a minute, so it cannot be served.
    const impossible = candidate('impossible', north(1_050), {
      deliverBefore: new Date(DEPART.getTime() + 60_000),
    })
    const workable = candidate('workable', north(1_200))

    const plan = planTrip(BRANCH, anchor, [impossible, workable], DEPART)

    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor', 'workable'])
  })

  it('never carries more than a bag holds', () => {
    const anchor = candidate('anchor', north(1_000))
    const crowd = Array.from({ length: 10 }, (_, index) =>
      candidate(`drop-${index}`, north(1_000 + index * 20)),
    )

    const plan = planTrip(BRANCH, anchor, crowd, DEPART)

    expect(plan.stops).toHaveLength(MAX_TRIP_DROPS)
  })

  it('will not collect from a second bakery', () => {
    const anchor = candidate('anchor', north(1_000))
    const otherBranch = candidate('other', north(1_050), { branchId: 'branch-2' })

    const plan = planTrip(BRANCH, anchor, [otherBranch], DEPART)

    // A rider collecting from two bakeries is two rides with the loaves going
    // cold in between — the opposite of the saving.
    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor'])
  })

  it('ignores the anchor appearing again in the pool', () => {
    const anchor = candidate('anchor', north(1_000))

    const plan = planTrip(BRANCH, anchor, [anchor], DEPART)

    expect(plan.stops).toHaveLength(1)
  })

  it('plans arrivals that account for the time spent at each door', () => {
    const anchor = candidate('anchor', north(1_000))
    const neighbour = candidate('neighbour', north(1_050))

    const plan = planTrip(BRANCH, anchor, [neighbour], DEPART)

    const first = plan.stops[0]!.plannedArrival.getTime()
    const second = plan.stops[1]!.plannedArrival.getTime()
    // Fifty metres of riding, but three minutes of parking, knocking and
    // handing over. A planner that ignored that would batch four drops and be
    // twelve minutes wrong by the last one.
    expect(second - first).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('uses a supplied distance function, so real roads can drive the plan', () => {
    const anchor = candidate('anchor', north(1_000))
    const neighbour = candidate('neighbour', north(1_050))

    // Fifty metres apart on the map, with a river and no bridge between them:
    // each is a short ride from the bakery, and twenty kilometres from the
    // other. This is exactly the case straight-line planning gets wrong.
    const acrossARiver = (
      origin: { latitude: number; longitude: number },
      destination: { latitude: number; longitude: number },
    ) => {
      const pair = [origin, destination]
      return pair.includes(anchor.destination) && pair.includes(neighbour.destination)
        ? 20_000
        : 1_000
    }

    const plan = planTrip(BRANCH, anchor, [neighbour], DEPART, {
      distanceBetween: acrossARiver,
    })

    expect(plan.stops.map((stop) => stop.taskId)).toEqual(['anchor'])
    // And with the straight line it would have been batched, which is the
    // reason the routing engine is worth wiring into the planner.
    expect(planTrip(BRANCH, anchor, [neighbour], DEPART).stops).toHaveLength(2)
  })

  it('refuses a plan that could never be ridden', () => {
    const anchor = candidate('anchor', north(1_000))

    expect(() => planTrip(BRANCH, anchor, [], DEPART, { maxDrops: 0 })).toThrow(DomainError)
    expect(() => planTrip(BRANCH, anchor, [], DEPART, { speedMetresPerSecond: 0 })).toThrow(
      DomainError,
    )
  })
})

describe('checking a run a dispatcher assembled by hand', () => {
  it('accepts a sequence that meets every promise', () => {
    expect(() =>
      assertTripIsDeliverable(
        BRANCH,
        [candidate('a', north(1_000)), candidate('b', north(1_100))],
        DEPART,
      ),
    ).not.toThrow()
  })

  it('refuses more drops than a bag holds', () => {
    const drops = Array.from({ length: MAX_TRIP_DROPS + 1 }, (_, index) =>
      candidate(`drop-${index}`, north(1_000 + index * 10)),
    )

    expect(() => assertTripIsDeliverable(BRANCH, drops, DEPART)).toThrow(
      expect.objectContaining({ code: 'TRIP_TOO_LARGE' }),
    )
  })

  it('refuses a run collecting from two branches', () => {
    expect(() =>
      assertTripIsDeliverable(
        BRANCH,
        [candidate('a', north(1_000)), candidate('b', north(1_050), { branchId: 'branch-2' })],
        DEPART,
      ),
    ).toThrow(expect.objectContaining({ code: 'TRIP_BRANCH_MISMATCH' }))
  })

  it('refuses a run that would deliver late, and names the drop', () => {
    expect(() =>
      assertTripIsDeliverable(
        BRANCH,
        [
          candidate('first', north(4_000)),
          candidate('late', north(4_100), {
            deliverBefore: new Date(DEPART.getTime() + 5 * 60_000),
          }),
        ],
        DEPART,
      ),
    ).toThrow(expect.objectContaining({ code: 'TRIP_WOULD_ARRIVE_LATE' }))
  })

  it('checks the order given, not a better one nobody will ride', () => {
    const far = candidate('far', north(6_000))
    const near = candidate('near', north(400), {
      deliverBefore: new Date(DEPART.getTime() + 10 * 60_000),
    })

    // Near-then-far makes the promise; far-then-near does not. A dispatcher who
    // sequenced it badly must be told, not silently re-sequenced.
    expect(() => assertTripIsDeliverable(BRANCH, [near, far], DEPART)).not.toThrow()
    expect(() => assertTripIsDeliverable(BRANCH, [far, near], DEPART)).toThrow(
      expect.objectContaining({ code: 'TRIP_WOULD_ARRIVE_LATE' }),
    )
  })

  it('refuses an empty run and a run carrying the same delivery twice', () => {
    expect(() => assertTripIsDeliverable(BRANCH, [], DEPART)).toThrow(DomainError)
    const twice = candidate('a', north(1_000))
    expect(() => assertTripIsDeliverable(BRANCH, [twice, twice], DEPART)).toThrow(DomainError)
  })
})

describe('the trip lifecycle', () => {
  it('moves from planned to dispatched to completed', () => {
    expect(transitionDeliveryTrip(DeliveryTripState.PLANNED, DeliveryTripState.DISPATCHED)).toBe(
      DeliveryTripState.DISPATCHED,
    )
    expect(transitionDeliveryTrip(DeliveryTripState.DISPATCHED, DeliveryTripState.COMPLETED)).toBe(
      DeliveryTripState.COMPLETED,
    )
  })

  it('refuses to reopen a finished run', () => {
    expect(() =>
      transitionDeliveryTrip(DeliveryTripState.COMPLETED, DeliveryTripState.DISPATCHED),
    ).toThrow(DomainError)
    expect(() =>
      transitionDeliveryTrip(DeliveryTripState.CANCELLED, DeliveryTripState.PLANNED),
    ).toThrow(DomainError)
  })

  it('only lets drops move while nobody is riding yet', () => {
    // Adding a drop to a rider already at the second door does not shorten
    // anything; it makes the last customer late for a saving already spent.
    expect(tripAcceptsChanges(DeliveryTripState.PLANNED)).toBe(true)
    expect(tripAcceptsChanges(DeliveryTripState.DISPATCHED)).toBe(false)
    expect(tripAcceptsChanges(DeliveryTripState.COMPLETED)).toBe(false)
  })
})
