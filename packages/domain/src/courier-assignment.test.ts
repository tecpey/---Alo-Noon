import { describe, expect, it } from 'vitest'

import {
  assignCouriers,
  assignmentCost,
  IDLE_MINUTE_WEIGHT,
  UNKNOWN_POSITION_METRES,
  type AssignableCourier,
  type AssignableRun,
} from './courier-assignment'
import { DomainError } from './errors'

const NOW = new Date('2026-08-26T09:00:00.000Z')
const ORIGIN = { latitude: 36.5442, longitude: 52.6781 }

function at(metresNorth: number, metresEast = 0) {
  return {
    latitude: ORIGIN.latitude + metresNorth / 111_000,
    longitude: ORIGIN.longitude + metresEast / 89_000,
  }
}

function run(runId: string, origin = ORIGIN, waitingSince: Date | null = null): AssignableRun {
  return { runId, origin, waitingSince }
}

function courier(
  courierId: string,
  lastKnownPosition: { latitude: number; longitude: number } | null,
  idleSince: Date | null = NOW,
): AssignableCourier {
  return { courierId, lastKnownPosition, idleSince }
}

describe('what a pairing costs', () => {
  it('is the ride to the pickup when the courier’s last drop is known', () => {
    const { approachMetres } = assignmentCost(run('r'), courier('c', at(1_000)), NOW)

    expect(approachMetres).toBeGreaterThan(950)
    expect(approachMetres).toBeLessThan(1_050)
  })

  it('treats an unknown position as neither near nor far', () => {
    // Preferring an unlocated rider would hand every run to whoever just
    // joined; shutting them out would mean they never get a first delivery.
    expect(assignmentCost(run('r'), courier('c', null), NOW).approachMetres).toBe(
      UNKNOWN_POSITION_METRES,
    )
  })

  it('credits waiting, but never enough to send a rider across town', () => {
    const near = assignmentCost(run('r'), courier('near', at(200)), NOW)
    const waitedTenMinutes = assignmentCost(
      run('r'),
      courier('waited', at(400), new Date(NOW.getTime() - 10 * 60_000)),
      NOW,
    )
    const waitedButFar = assignmentCost(
      run('r'),
      courier('far', at(30_000), new Date(NOW.getTime() - 10 * 60_000)),
      NOW,
    )

    // Ten minutes beats two hundred metres.
    expect(waitedTenMinutes.cost).toBeLessThan(near.cost)
    // Ten minutes does not beat thirty kilometres.
    expect(waitedButFar.cost).toBeGreaterThan(near.cost)
  })

  it('stops crediting idleness past the cap', () => {
    const twoHours = assignmentCost(
      run('r'),
      courier('c', at(100), new Date(NOW.getTime() - 120 * 60_000)),
      NOW,
    )
    const twoDays = assignmentCost(
      run('r'),
      courier('c', at(100), new Date(NOW.getTime() - 2_880 * 60_000)),
      NOW,
    )

    // Otherwise a rider off all week wins every run on their return.
    expect(twoDays.cost).toBe(twoHours.cost)
  })

  it('treats a courier who has finished nothing as freshly idle, not maximally', () => {
    const brandNew = assignmentCost(run('r'), courier('new', at(100), null), NOW)
    const justFinished = assignmentCost(run('r'), courier('busy', at(100), NOW), NOW)

    expect(brandNew.cost).toBe(justFinished.cost)
  })

  it('ignores a clock that runs backwards rather than paying for it', () => {
    const future = assignmentCost(
      run('r'),
      courier('c', at(100), new Date(NOW.getTime() + 60 * 60_000)),
      NOW,
    )
    const now = assignmentCost(run('r'), courier('c', at(100), NOW), NOW)

    expect(future.cost).toBe(now.cost)
  })
})

describe('assigning everything at once', () => {
  it('beats assigning each run to its nearest courier in turn', () => {
    // The trap, laid out on a line. Courier X sits at the bakery; courier Y is
    // 300 metres up the road. Run A collects from 140 metres up — near enough to
    // either. Run B collects from the bakery itself, where only X is.
    //
    // A dispatcher working down the list gives A to X, because X is marginally
    // nearer, and then B has to bring Y the whole 300 metres. Solving both
    // together sends A to Y, who was nearly as close, and leaves X standing
    // exactly where B needs them.
    const runs = [run('A', at(140)), run('B', at(0))]
    const couriers = [courier('X', at(0)), courier('Y', at(300))]

    const plan = assignCouriers(runs, couriers, NOW)

    expect(pairFor(plan, 'A')).toBe('Y')
    expect(pairFor(plan, 'B')).toBe('X')
    // And the plan says by how much, because an optimisation nobody can measure
    // is one nobody should trust.
    expect(plan.totalCost).toBeLessThan(plan.greedyCost)
  })

  it('says how many metres it saves, not only how many points', () => {
    const runs = [run('A', at(140)), run('B', at(0))]
    const couriers = [courier('X', at(0)), courier('Y', at(300))]

    const plan = assignCouriers(runs, couriers, NOW)

    // The cost carries the fairness credit, so a cheaper plan is not
    // automatically a shorter one. Whoever has to justify this feature is
    // justifying the metres.
    expect(plan.totalApproachMetres).toBeLessThan(plan.greedyApproachMetres)
    expect(plan.totalApproachMetres).toBe(
      plan.pairs.reduce((sum, pair) => sum + pair.approachMetres, 0),
    )
  })

  it('agrees with the obvious answer when the obvious answer is right', () => {
    const runs = [run('A', at(0)), run('B', at(5_000))]
    const couriers = [courier('X', at(100)), courier('Y', at(5_100))]

    const plan = assignCouriers(runs, couriers, NOW)

    expect(pairFor(plan, 'A')).toBe('X')
    expect(pairFor(plan, 'B')).toBe('Y')
    expect(plan.totalCost).toBe(plan.greedyCost)
  })

  it('finds the cheapest pairing among many, not merely a good one', () => {
    // Four runs on a line and four couriers on the same line, deliberately
    // shuffled. The only cheap answer is the one that pairs them in order.
    const positions = [0, 3_000, 6_000, 9_000]
    const runs = positions.map((metres, index) => run(`R${index}`, at(metres)))
    const couriers = [3, 1, 0, 2].map((index) => courier(`C${index}`, at(positions[index]!)))

    const plan = assignCouriers(runs, couriers, NOW)

    expect(plan.pairs).toHaveLength(4)
    for (const [index] of positions.entries()) {
      expect(pairFor(plan, `R${index}`)).toBe(`C${index}`)
    }
  })

  it('leaves runs unassigned rather than double-booking a courier', () => {
    const runs = [run('A', at(0)), run('B', at(100)), run('C', at(200))]
    const couriers = [courier('X', at(50))]

    const plan = assignCouriers(runs, couriers, NOW)

    // A courier holding two separate runs is a promise to two customers that
    // only one of them can be kept.
    expect(plan.pairs).toHaveLength(1)
    expect(plan.unassignedRunIds).toHaveLength(2)
    expect(new Set(plan.pairs.map((pair) => pair.courierId)).size).toBe(1)
  })

  it('leaves the run that has waited least when riders are scarce', () => {
    const waited = run('waited', at(0), new Date(NOW.getTime() - 45 * 60_000))
    const justPlaced = run('just-placed', at(0), new Date(NOW.getTime() - 60_000))

    const plan = assignCouriers([justPlaced, waited], [courier('X', at(0))], NOW)

    // Order in, order out is not a rule anybody would defend; the customer who
    // has waited three quarters of an hour going last is worse than arbitrary.
    expect(plan.pairs.map((pair) => pair.runId)).toEqual(['waited'])
    expect(plan.unassignedRunIds).toEqual(['just-placed'])
  })

  it('does not let a run’s waiting send a courier further', () => {
    const old = run('old', at(0), new Date(NOW.getTime() - 300 * 60_000))
    const fresh = run('fresh', at(5_000), new Date(NOW.getTime() - 60_000))

    const plan = assignCouriers(
      [old, fresh],
      [courier('near', at(0)), courier('far', at(5_000))],
      NOW,
    )

    // The waiting credit is the same for every courier in a run's row, so a
    // long-waiting order cannot pull the wrong rider across the city to it.
    expect(pairFor(plan, 'old')).toBe('near')
    expect(pairFor(plan, 'fresh')).toBe('far')
  })

  it('leaves spare couriers spare', () => {
    const plan = assignCouriers(
      [run('A', at(0))],
      [courier('X', at(100)), courier('Y', at(5_000)), courier('Z', at(9_000))],
      NOW,
    )

    expect(plan.pairs).toHaveLength(1)
    expect(plan.pairs[0]!.courierId).toBe('X')
    expect(plan.unassignedRunIds).toEqual([])
  })

  it('breaks a tie toward the courier who has been waiting', () => {
    const runs = [run('A', at(0))]
    const couriers = [
      courier('just-finished', at(500), NOW),
      courier('waiting', at(500), new Date(NOW.getTime() - 30 * 60_000)),
    ]

    const plan = assignCouriers(runs, couriers, NOW)

    // Couriers are paid per delivery. Pure distance minimisation would give
    // every run to the same rider all day, which is a rota nobody agreed to.
    expect(plan.pairs[0]!.courierId).toBe('waiting')
  })

  it('reports the ride each courier faces, not only the score', () => {
    const plan = assignCouriers([run('A', at(0))], [courier('X', at(1_000))], NOW)

    // A dispatcher overruling the plan needs the distance, which is a thing
    // about the world; the cost is a thing about our policy.
    expect(plan.pairs[0]!.approachMetres).toBeGreaterThan(950)
    expect(plan.pairs[0]!.approachMetres).toBeLessThan(1_050)
  })

  it('uses a supplied distance function, so real roads can drive the choice', () => {
    const runs = [run('A', at(0))]
    const couriers = [courier('near-on-a-map', at(100)), courier('near-by-road', at(2_000))]

    const plan = assignCouriers(runs, couriers, NOW, {
      // The nearby rider is on the far side of a river.
      distanceBetween: (origin) =>
        Math.abs(origin.latitude - at(100).latitude) < 1e-9 ? 40_000 : 2_000,
    })

    expect(plan.pairs[0]!.courierId).toBe('near-by-road')
  })

  it('handles having nothing to do', () => {
    expect(assignCouriers([], [courier('X', at(0))], NOW).pairs).toEqual([])
    const noCouriers = assignCouriers([run('A', at(0))], [], NOW)
    expect(noCouriers.pairs).toEqual([])
    expect(noCouriers.unassignedRunIds).toEqual(['A'])
  })

  it('refuses input that would silently assign something twice', () => {
    expect(() => assignCouriers([run('A'), run('A')], [courier('X', null)], NOW)).toThrow(
      DomainError,
    )
    expect(() => assignCouriers([run('A')], [courier('X', null), courier('X', null)], NOW)).toThrow(
      DomainError,
    )
  })

  it('never assigns one courier to two runs, however the costs fall', () => {
    // A pathological matrix: every courier is equally good everywhere, which is
    // exactly where a careless implementation collapses onto one column.
    const runs = Array.from({ length: 6 }, (_, index) => run(`R${index}`, ORIGIN))
    const couriers = Array.from({ length: 6 }, (_, index) => courier(`C${index}`, ORIGIN))

    const plan = assignCouriers(runs, couriers, NOW)

    expect(plan.pairs).toHaveLength(6)
    expect(new Set(plan.pairs.map((pair) => pair.courierId)).size).toBe(6)
    expect(new Set(plan.pairs.map((pair) => pair.runId)).size).toBe(6)
  })

  it('is exact — no reshuffling of its answer is cheaper', () => {
    const runs = [at(0), at(2_000), at(7_000)].map((position, index) => run(`R${index}`, position))
    const couriers = [at(6_800), at(300), at(2_400)].map((position, index) =>
      courier(`C${index}`, position),
    )

    const plan = assignCouriers(runs, couriers, NOW)

    // Brute force over all 3! pairings. The point of using an algorithm with a
    // proof rather than a heuristic is that this holds, so it is checked.
    const courierIds = couriers.map((entry) => entry.courierId)
    let best = Number.POSITIVE_INFINITY
    for (const permutation of permutations(courierIds)) {
      const total = runs.reduce(
        (sum, entry, index) =>
          sum + assignmentCost(entry, courierFor(couriers, permutation[index]!), NOW).cost,
        0,
      )
      best = Math.min(best, total)
    }
    expect(plan.totalCost).toBeCloseTo(best, 6)
  })
})

describe('the weights are the policy', () => {
  it('states the exchange rate between waiting and riding', () => {
    // Ten minutes of waiting is worth six kilometres of riding. Written as a
    // test so changing the ratio is a decision somebody makes on purpose.
    expect(IDLE_MINUTE_WEIGHT * 10).toBe(6_000)
  })
})

function pairFor(plan: ReturnType<typeof assignCouriers>, runId: string): string | undefined {
  return plan.pairs.find((pair) => pair.runId === runId)?.courierId
}

function courierFor(couriers: readonly AssignableCourier[], courierId: string) {
  return couriers.find((entry) => entry.courierId === courierId)!
}

function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (values.length <= 1) {
    yield [...values]
    return
  }
  for (const [index, value] of values.entries()) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)]
    for (const permutation of permutations(rest)) yield [value, ...permutation]
  }
}
