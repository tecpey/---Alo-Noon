import { DomainError } from './errors'
import { calculateDeliveryDistanceMeters, type DeliveryCoordinates } from './delivery-pricing'

/**
 * Choosing which courier takes which run, all at once rather than one at a time.
 *
 * A dispatcher assigning by hand does the obvious thing: give each run to the
 * nearest free rider, in whatever order the runs appear on screen. That is
 * greedy, and greedy is not merely imperfect here — it is reliably worse in a
 * specific way. The first run takes the rider who happens to be nearest it, and
 * that rider was the only one anywhere near the second run. Two riders end up
 * crossing the city past each other.
 *
 * Solving all the pairings together avoids that. The algorithm below finds the
 * assignment with the lowest total cost, which is a different answer from the
 * lowest cost for each run in turn, and the gap between them is exactly the
 * crossing.
 *
 * **What "cost" can honestly mean here.** Nothing in this system records where a
 * courier physically is: there is no location feed, no app heartbeat, no GPS.
 * Inventing a distance from a position we do not have would produce a confident
 * number with nothing behind it. What is known is where each courier *last
 * delivered*, which is where they are until they move — a real signal, and
 * stated as an estimate rather than a fact. A courier with no completed
 * deliveries has no known position and is costed as neither near nor far, since
 * guessing either way would systematically favour or starve every new rider.
 *
 * **Why fairness is in the cost at all.** Pure distance minimisation gives every
 * run to whoever happens to live near the busy branch, all day, every day.
 * Couriers are paid per delivery, so that is not an optimisation — it is a
 * rota nobody agreed to. The idle term is small enough that it never sends a run
 * across town, and large enough to break ties toward the rider who has been
 * waiting. A second fairness term does the same for customers: when there are
 * fewer riders than runs, the run left behind is the newest one rather than
 * whichever the arithmetic happened to drop.
 *
 * **Where the gain actually comes from.** Every run is collected from a bakery,
 * so two runs leaving the same branch cost the same courier the same ride, and
 * on a single-branch board this finds what any dispatcher would. The crossing it
 * prevents is between branches — which is precisely the case a person cannot
 * hold in their head, and precisely why the plan publishes the one-at-a-time
 * figure beside its own instead of claiming a saving.
 */

/**
 * How much a metre of riding counts against a minute of waiting.
 *
 * At 1 unit per metre and 600 units per idle minute, ten minutes of waiting is
 * worth 6 km of riding — enough to break a tie between two riders in the same
 * neighbourhood, and never enough to send someone across a city. The units are
 * arbitrary; only the ratio matters, and the ratio is the policy.
 */
export const IDLE_MINUTE_WEIGHT = 600

/** Idle credit stops accruing here, so a rider off all week does not win everything. */
export const MAX_IDLE_MINUTES = 120

/**
 * What a courier with no known position costs.
 *
 * Neither near nor far: about the distance across a working delivery zone. A
 * new rider must not be preferred for being unknown, nor shut out for it.
 */
export const UNKNOWN_POSITION_METRES = 3_000

/**
 * How much a minute of a run waiting counts, when there are fewer riders than
 * runs and something must be left behind.
 *
 * Uncapped, unlike the courier's idle credit, and safely so: this term is the
 * same for every courier in a run's row, so it cannot send anybody further. It
 * decides only which runs go unassigned — and there the right answer is the
 * plain one, that the order which has waited longest is not the one asked to
 * wait again.
 */
export const RUN_WAIT_MINUTE_WEIGHT = 600

export interface AssignableCourier {
  readonly courierId: string
  /**
   * Where this courier last delivered, which is where they are until they move.
   * Null when they have delivered nothing yet.
   */
  readonly lastKnownPosition: DeliveryCoordinates | null
  /** When they last finished a delivery. Null when they have finished none. */
  readonly idleSince: Date | null
}

export interface AssignableRun {
  readonly runId: string
  /** Where the courier must collect from. */
  readonly origin: DeliveryCoordinates
  /**
   * Since when this run has been waiting for a rider. Optional: it changes
   * nothing when every run can be assigned, and decides who is left when they
   * cannot.
   */
  readonly waitingSince?: Date | null
}

export interface AssignmentPair {
  readonly runId: string
  readonly courierId: string
  /** The estimated riding distance to the pickup, in metres. */
  readonly approachMetres: number
  readonly cost: number
}

export interface AssignmentPlan {
  readonly pairs: readonly AssignmentPair[]
  /** Runs left over because there were more runs than couriers. */
  readonly unassignedRunIds: readonly string[]
  readonly totalCost: number
  /**
   * What assigning each run to its own nearest courier in turn would have cost.
   * Kept so the difference is visible: an optimisation nobody can measure is an
   * optimisation nobody should trust.
   */
  readonly greedyCost: number
  /** Metres of approach riding this plan asks for, summed over its pairs. */
  readonly totalApproachMetres: number
  /**
   * Metres the one-at-a-time assignment would have asked for.
   *
   * Reported beside the cost because the cost is a policy score — it contains
   * the fairness credit, so a cheaper plan is not automatically a shorter one.
   * Metres are a thing about the world, and an operator judging whether this is
   * worth having should be shown the thing about the world.
   */
  readonly greedyApproachMetres: number
}

export interface AssignmentOptions {
  readonly idleMinuteWeight?: number
  readonly runWaitMinuteWeight?: number
  readonly maxIdleMinutes?: number
  readonly unknownPositionMetres?: number
  readonly distanceBetween?: (
    origin: DeliveryCoordinates,
    destination: DeliveryCoordinates,
  ) => number
}

/**
 * The cost of sending one courier to one pickup.
 *
 * Exported because it is the policy, not an implementation detail: an operator
 * arguing that their riders are being sent too far, or that a new rider never
 * gets work, is arguing about this function and should be able to read it.
 */
export function assignmentCost(
  run: AssignableRun,
  courier: AssignableCourier,
  now: Date,
  options: AssignmentOptions = {},
): { cost: number; approachMetres: number } {
  const idleWeight = options.idleMinuteWeight ?? IDLE_MINUTE_WEIGHT
  const maxIdle = options.maxIdleMinutes ?? MAX_IDLE_MINUTES
  const unknownMetres = options.unknownPositionMetres ?? UNKNOWN_POSITION_METRES
  const distanceBetween = options.distanceBetween ?? calculateDeliveryDistanceMeters

  const approachMetres = courier.lastKnownPosition
    ? distanceBetween(courier.lastKnownPosition, run.origin)
    : unknownMetres

  // A courier who has never finished a delivery is treated as freshly idle
  // rather than as maximally idle: being new is not the same as being ignored,
  // and the latter would hand a new rider every run on their first shift.
  const idleMinutes = courier.idleSince
    ? Math.min(maxIdle, Math.max(0, (now.getTime() - courier.idleSince.getTime()) / 60_000))
    : 0

  // Constant across a run's row, so it never changes which courier the run gets
  // — only whether this run keeps a courier at all when they are scarce.
  const waitWeight = options.runWaitMinuteWeight ?? RUN_WAIT_MINUTE_WEIGHT
  const waitingMinutes = run.waitingSince
    ? Math.max(0, (now.getTime() - run.waitingSince.getTime()) / 60_000)
    : 0

  return {
    approachMetres,
    cost: approachMetres - idleMinutes * idleWeight - waitingMinutes * waitWeight,
  }
}

/**
 * Assigns runs to couriers at the lowest total cost.
 *
 * The Hungarian method, in its O(n³) shortest-augmenting-path form. It is exact:
 * for the cost function given, no other pairing is cheaper. That matters more
 * than speed here, because the alternative is not a slower exact answer but a
 * fast wrong one — and the wrong one is what a dispatcher would have done
 * unaided, so an approximation would be work for nothing.
 *
 * More runs than couriers is normal during a rush. The extra runs are returned
 * unassigned rather than being forced onto a rider who is already carrying one,
 * because a courier holding two separate runs is not batching — it is a promise
 * to two customers that only one of them can be kept.
 */
export function assignCouriers(
  runs: readonly AssignableRun[],
  couriers: readonly AssignableCourier[],
  now: Date,
  options: AssignmentOptions = {},
): Readonly<AssignmentPlan> {
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    throw new DomainError('INVALID_ASSIGNMENT_INPUT', 'A run cannot be assigned twice')
  }
  if (new Set(couriers.map((courier) => courier.courierId)).size !== couriers.length) {
    throw new DomainError('INVALID_ASSIGNMENT_INPUT', 'A courier cannot appear twice')
  }
  if (runs.length === 0 || couriers.length === 0) {
    return Object.freeze({
      pairs: [],
      unassignedRunIds: runs.map((run) => run.runId),
      totalCost: 0,
      greedyCost: 0,
      totalApproachMetres: 0,
      greedyApproachMetres: 0,
    })
  }

  const detail = runs.map((run) =>
    couriers.map((courier) => assignmentCost(run, courier, now, options)),
  )
  const cost = detail.map((row) => row.map((entry) => entry.cost))

  const matched = hungarian(cost)
  const pairs: AssignmentPair[] = []
  const unassignedRunIds: string[] = []
  let totalCost = 0
  let totalApproachMetres = 0

  for (const [runIndex, run] of runs.entries()) {
    const courierIndex = matched[runIndex]
    if (courierIndex === undefined || courierIndex < 0) {
      unassignedRunIds.push(run.runId)
      continue
    }
    const entry = detail[runIndex]![courierIndex]!
    totalCost += entry.cost
    totalApproachMetres += entry.approachMetres
    pairs.push({
      runId: run.runId,
      courierId: couriers[courierIndex]!.courierId,
      approachMetres: entry.approachMetres,
      cost: entry.cost,
    })
  }

  const greedy = greedyTotal(detail)
  return Object.freeze({
    pairs: Object.freeze(pairs),
    unassignedRunIds: Object.freeze(unassignedRunIds),
    totalCost,
    totalApproachMetres,
    greedyCost: greedy.cost,
    greedyApproachMetres: greedy.approachMetres,
  })
}

/**
 * What a dispatcher assigning one run at a time would have spent.
 *
 * Computed the way a person actually works: take the runs in the order they
 * appear, give each one its cheapest remaining courier. This is the baseline the
 * optimal answer is measured against, and it is why the plan reports both.
 */
function greedyTotal(detail: readonly (readonly { cost: number; approachMetres: number }[])[]): {
  cost: number
  approachMetres: number
} {
  const taken = new Set<number>()
  let cost = 0
  let approachMetres = 0
  for (const row of detail) {
    let bestIndex = -1
    let best = Number.POSITIVE_INFINITY
    for (const [index, entry] of row.entries()) {
      if (taken.has(index) || entry.cost >= best) continue
      best = entry.cost
      bestIndex = index
    }
    if (bestIndex === -1) continue
    taken.add(bestIndex)
    cost += best
    approachMetres += row[bestIndex]!.approachMetres
  }
  return { cost, approachMetres }
}

/**
 * The Hungarian method: minimum-cost perfect matching on a rectangular matrix.
 *
 * Rows are runs, columns are couriers. Returns, for each row, the column it was
 * matched to, or -1 when there were more rows than columns and this one went
 * unmatched.
 *
 * This is the standard potentials-and-augmenting-paths formulation. The
 * invariant it maintains is that `rowPotential[i] + columnPotential[j] <=
 * cost[i][j]` for every pair, with equality on matched pairs — so when every row
 * is matched, no cheaper assignment exists. The proof is what makes it worth
 * using an algorithm here rather than a heuristic.
 */
function hungarian(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length
  const columns = cost[0]?.length ?? 0
  // The algorithm needs at least as many columns as rows; when runs outnumber
  // couriers the extra runs are matched against padding columns that cost
  // nothing, and are reported as unassigned afterwards.
  const size = Math.max(rows, columns)
  const padded: number[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => cost[row]?.[column] ?? 0),
  )

  const INF = Number.POSITIVE_INFINITY
  const rowPotential = new Array<number>(size + 1).fill(0)
  const columnPotential = new Array<number>(size + 1).fill(0)
  // columnMatch[j] is the row matched to column j, or 0 for unmatched. Index 0
  // is a sentinel, which is why these arrays are one longer than the matrix.
  const columnMatch = new Array<number>(size + 1).fill(0)
  const path = new Array<number>(size + 1).fill(0)

  for (let row = 1; row <= size; row += 1) {
    columnMatch[0] = row
    let column = 0
    const minimum = new Array<number>(size + 1).fill(INF)
    const used = new Array<boolean>(size + 1).fill(false)

    do {
      used[column] = true
      const currentRow = columnMatch[column]!
      let delta = INF
      let nextColumn = 0

      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue
        const reduced =
          padded[currentRow - 1]![candidate - 1]! -
          rowPotential[currentRow]! -
          columnPotential[candidate]!
        if (reduced < minimum[candidate]!) {
          minimum[candidate] = reduced
          path[candidate] = column
        }
        if (minimum[candidate]! < delta) {
          delta = minimum[candidate]!
          nextColumn = candidate
        }
      }

      // Shifting the potentials by delta keeps every reduced cost non-negative
      // while making at least one of them zero, which is what admits the next
      // edge into the equality subgraph.
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          const matchedRow = columnMatch[candidate]!
          rowPotential[matchedRow] = rowPotential[matchedRow]! + delta
          columnPotential[candidate] = columnPotential[candidate]! - delta
        } else {
          minimum[candidate] = minimum[candidate]! - delta
        }
      }
      column = nextColumn
    } while (columnMatch[column] !== 0)

    // Walk the augmenting path back, flipping matched and unmatched edges.
    do {
      const previous = path[column]!
      columnMatch[column] = columnMatch[previous]!
      column = previous
    } while (column !== 0)
  }

  const assignment = new Array<number>(rows).fill(-1)
  for (let column = 1; column <= size; column += 1) {
    const row = columnMatch[column]!
    // Padding rows and columns are dropped: they exist only to square the
    // matrix, and matching against one means "not assigned".
    if (row >= 1 && row <= rows && column <= columns) assignment[row - 1] = column - 1
  }
  return assignment
}
