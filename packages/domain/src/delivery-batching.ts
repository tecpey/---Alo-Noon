import { DomainError } from './errors'
import { calculateDeliveryDistanceMeters, type DeliveryCoordinates } from './delivery-pricing'

/**
 * Putting several orders on one courier, and the reasons not to.
 *
 * One rider carrying three loaves to three doors on the same street is the
 * largest cost lever left in the delivery plan: the ride to the neighbourhood is
 * paid once instead of three times, and the ride back not at all. The batch
 * density in the logistics report exists to make that saving visible, and it
 * reads 1.00 until this is used.
 *
 * The saving is real and the risk is specific: **the second customer pays for
 * the first one's convenience in minutes.** Bread is time-critical, a courier
 * carrying four bags arrives at the fourth door much later than a courier
 * carrying one, and nobody who ordered bread agreed to wait so the bakery could
 * save a trip. So every rule here is a refusal, and the planner's job is to find
 * the batch that survives them rather than the batch that is largest.
 *
 * Four refusals, in the order they bite:
 *
 * **One pickup.** Only orders leaving the same branch may share a run. A rider
 * collecting from two bakeries is two rides with the loaves going cold in
 * between, which is the opposite of the saving.
 *
 * **Nobody arrives late.** Each drop's own deadline is checked against when the
 * planned sequence actually reaches it. A batch that would make any single drop
 * late is not a smaller batch — it is refused, and the order goes out alone.
 *
 * **Nobody detours far.** A drop that adds more than its share of extra riding
 * is not batched, however early its deadline. Deadlines are what a customer was
 * promised; detour is what the courier is actually asked to do, and a rider sent
 * across town and back within the promise is still a rider who will not take the
 * next job.
 *
 * **A bag holds what a bag holds.** A motorcycle carries a few orders, not ten.
 */

/** The most drops one run may carry, whatever the geometry says. */
export const MAX_TRIP_DROPS = 4

/**
 * What a drop may cost on a shared run, as a share of what it would cost alone.
 *
 * A drop's marginal cost is the extra riding it adds to a run that has to return
 * to the branch anyway: the leg out to it, plus the leg home from it, less the
 * leg home the courier would have ridden without it. Its solo cost is the round
 * trip it would take on its own.
 *
 * 0.6 means a drop joins only if sharing costs at most sixty per cent of
 * delivering it separately — a saving of forty per cent or the batch is refused.
 *
 * Marginal cost rather than "distance added so far" matters more than it looks.
 * A drop between the last stop and the bakery is nearly free, because the
 * courier rides past it on the way home; a rule measuring only the outbound leg
 * would refuse it for being a long way from the previous stop, and would keep
 * refusing exactly the drops worth taking.
 */
export const MAX_DETOUR_SHARE = 0.6

/**
 * Slack kept between a planned arrival and the deadline it must not pass.
 *
 * Traffic, a locked gate, a customer who does not answer the intercom — a plan
 * with no margin is a plan that fails on its first surprise, and the surprise is
 * paid for by whoever is last in the sequence.
 */
export const TRIP_DEADLINE_MARGIN_MS = 5 * 60_000

/**
 * How long a drop takes once the courier has arrived: parking, finding the
 * door, handing over, a signature. Not travel time, and easily the difference
 * between a plan that works and one that runs twenty minutes late over four
 * stops.
 */
export const DROP_SERVICE_TIME_MS = 3 * 60_000

/**
 * Assumed riding speed when nothing better is known, in metres per second.
 *
 * About 18 km/h — a motorcycle in city traffic, not a motorcycle on a map. It is
 * used only to turn a planned distance into a planned arrival time, and it is
 * deliberately pessimistic: overestimating speed produces batches that look
 * feasible and arrive late, which is the failure this module exists to prevent.
 */
export const ASSUMED_SPEED_METRES_PER_SECOND = 5

export interface BatchCandidate {
  readonly taskId: string
  readonly branchId: string
  readonly destination: DeliveryCoordinates
  /** When this drop must have arrived. Null when the order set no promise. */
  readonly deliverBefore: Date | null
  /** When the bread is ready to leave the branch. Null when it already is. */
  readonly readyAt: Date | null
}

export interface TripPlanStop {
  readonly taskId: string
  readonly sequence: number
  /** Riding distance from the previous stop, or from the branch for the first. */
  readonly legMetres: number
  readonly plannedArrival: Date
}

export interface TripPlan {
  readonly branchId: string
  readonly stops: readonly TripPlanStop[]
  readonly totalMetres: number
  /**
   * What this plan saves against delivering each drop on its own run, in metres.
   * Zero for a single-drop plan, which is the honest answer rather than a
   * flattering one.
   */
  readonly savedMetres: number
}

export interface TripPlanningOptions {
  readonly maxDrops?: number
  readonly maxDetourShare?: number
  readonly deadlineMarginMs?: number
  readonly dropServiceTimeMs?: number
  readonly speedMetresPerSecond?: number
  /**
   * Distance between two points. Injected so a planner with a routing engine
   * can use real road distances, and so the default — the straight line — is a
   * visible choice rather than a hidden one. Straight-line planning is
   * *optimistic* about how close two drops are, which is why the deadline check
   * uses a pessimistic speed to compensate.
   */
  readonly distanceBetween?: (
    origin: DeliveryCoordinates,
    destination: DeliveryCoordinates,
  ) => number
}

/**
 * Builds the best run that can be made starting from one order.
 *
 * Nearest-neighbour from the branch, refusing at each step any drop that breaks
 * a rule. It is not the optimal tour — that is NP-hard and the difference over
 * four stops is metres — but it is stable, explicable, and its refusals are the
 * part that matters. A dispatcher looking at a batch has to be able to see why
 * the fifth order is not in it.
 *
 * `anchor` is the order the run is built around, and it is always the run's
 * first commitment: batching exists to help an order that already needs
 * delivering, never to hold one back while a companion is found.
 */
export function planTrip(
  branch: DeliveryCoordinates,
  anchor: BatchCandidate,
  candidates: readonly BatchCandidate[],
  departAt: Date,
  options: TripPlanningOptions = {},
): Readonly<TripPlan> {
  const maxDrops = options.maxDrops ?? MAX_TRIP_DROPS
  const maxDetourShare = options.maxDetourShare ?? MAX_DETOUR_SHARE
  const marginMs = options.deadlineMarginMs ?? TRIP_DEADLINE_MARGIN_MS
  const serviceMs = options.dropServiceTimeMs ?? DROP_SERVICE_TIME_MS
  const speed = options.speedMetresPerSecond ?? ASSUMED_SPEED_METRES_PER_SECOND
  const distanceBetween = options.distanceBetween ?? calculateDeliveryDistanceMeters

  if (maxDrops < 1) {
    throw new DomainError('INVALID_TRIP_PLAN', 'A trip must be allowed at least one drop')
  }
  if (speed <= 0) {
    throw new DomainError('INVALID_TRIP_PLAN', 'A courier cannot travel at zero speed')
  }

  const pool = candidates.filter(
    (candidate) => candidate.taskId !== anchor.taskId && candidate.branchId === anchor.branchId,
  )

  const stops: TripPlanStop[] = []
  let position = branch
  let clock = departAt.getTime()
  let totalMetres = 0
  let soloMetres = 0

  const commit = (candidate: BatchCandidate, legMetres: number): void => {
    clock += Math.ceil((legMetres / speed) * 1_000) + serviceMs
    totalMetres += legMetres
    soloMetres += 2 * distanceBetween(branch, candidate.destination)
    stops.push({
      taskId: candidate.taskId,
      sequence: stops.length + 1,
      legMetres,
      plannedArrival: new Date(clock),
    })
    position = candidate.destination
  }

  /**
   * The extra riding this drop adds to a run that ends back at the branch.
   *
   * Compared against what the same drop would cost on its own, this is the only
   * question worth asking: batching exists to save riding, so a drop that does
   * not save riding does not belong on the run however near it looks.
   */
  const marginalCost = (candidate: BatchCandidate, legMetres: number): number =>
    legMetres + distanceBetween(candidate.destination, branch) - distanceBetween(position, branch)

  // The anchor goes on unconditionally. Refusing it would be refusing to deliver
  // an order rather than refusing to batch one.
  commit(anchor, distanceBetween(branch, anchor.destination))

  const remaining = [...pool]
  while (stops.length < maxDrops && remaining.length > 0) {
    let bestIndex = -1
    let bestLeg = Number.POSITIVE_INFINITY

    for (const [index, candidate] of remaining.entries()) {
      const legMetres = distanceBetween(position, candidate.destination)
      if (legMetres >= bestLeg) continue
      // Both rules are applied to the candidate under consideration rather than
      // to the winner afterwards: a nearer drop that breaks one must not block a
      // slightly further one that does not.
      const soloCost = 2 * distanceBetween(branch, candidate.destination)
      if (soloCost > 0 && marginalCost(candidate, legMetres) > soloCost * maxDetourShare) {
        continue
      }
      if (!arrivesInTime(candidate, clock, legMetres, speed, serviceMs, marginMs)) continue
      // Appending delays nothing already committed, because nearest-neighbour
      // only ever adds to the end. That is why this is a per-candidate check
      // rather than a re-plan of the whole sequence.
      bestIndex = index
      bestLeg = legMetres
    }

    if (bestIndex === -1) break
    const chosen = remaining.splice(bestIndex, 1)[0]!
    commit(chosen, bestLeg)
  }

  // Both sides include the ride home, so they are the same journey measured two
  // ways. Counting the return for the solo case and not for the batch would
  // make a single-drop run look like it saved something, which is the kind of
  // flattering number that makes a metric useless.
  const loopMetres = totalMetres + distanceBetween(position, branch)

  return Object.freeze({
    branchId: anchor.branchId,
    stops: Object.freeze(stops),
    totalMetres,
    savedMetres: Math.max(0, soloMetres - loopMetres),
  })
}

/**
 * Whether a drop can still make its promise if it is added here.
 *
 * The margin is subtracted from the deadline rather than added to the estimate,
 * which is the same arithmetic but the honest framing: the promise does not
 * move, our willingness to cut it fine does.
 */
function arrivesInTime(
  candidate: BatchCandidate,
  clockMs: number,
  legMetres: number,
  speed: number,
  serviceMs: number,
  marginMs: number,
): boolean {
  if (candidate.deliverBefore === null) return true
  const arrival = clockMs + Math.ceil((legMetres / speed) * 1_000) + serviceMs
  return arrival <= candidate.deliverBefore.getTime() - marginMs
}

/**
 * Whether a set of orders may legally be offered as one run.
 *
 * Separate from the planner because the planner builds and this checks: an
 * operator dragging four orders onto one courier by hand needs the same rules
 * applied to their choice, and a rule enforced only inside the automatic path is
 * a rule the manual path quietly ignores.
 */
export function assertTripIsDeliverable(
  branch: DeliveryCoordinates,
  candidates: readonly BatchCandidate[],
  departAt: Date,
  options: TripPlanningOptions = {},
): void {
  if (candidates.length === 0) {
    throw new DomainError('INVALID_TRIP_PLAN', 'A trip needs at least one drop')
  }
  const maxDrops = options.maxDrops ?? MAX_TRIP_DROPS
  if (candidates.length > maxDrops) {
    throw new DomainError(
      'TRIP_TOO_LARGE',
      `A trip may carry at most ${maxDrops} drops, and this one carries ${candidates.length}`,
    )
  }
  const first = candidates[0]!
  if (candidates.some((candidate) => candidate.branchId !== first.branchId)) {
    throw new DomainError(
      'TRIP_BRANCH_MISMATCH',
      'Every drop on a trip must be collected from the same branch',
    )
  }
  const seen = new Set(candidates.map((candidate) => candidate.taskId))
  if (seen.size !== candidates.length) {
    throw new DomainError('INVALID_TRIP_PLAN', 'A trip cannot carry the same delivery twice')
  }

  // The order given is the order it will be ridden, so lateness is checked
  // against that sequence rather than against a better one nobody will follow.
  const distanceBetween = options.distanceBetween ?? calculateDeliveryDistanceMeters
  const speed = options.speedMetresPerSecond ?? ASSUMED_SPEED_METRES_PER_SECOND
  const serviceMs = options.dropServiceTimeMs ?? DROP_SERVICE_TIME_MS
  const marginMs = options.deadlineMarginMs ?? TRIP_DEADLINE_MARGIN_MS

  let position = branch
  let clock = departAt.getTime()
  for (const candidate of candidates) {
    const legMetres = distanceBetween(position, candidate.destination)
    if (!arrivesInTime(candidate, clock, legMetres, speed, serviceMs, marginMs)) {
      throw new DomainError(
        'TRIP_WOULD_ARRIVE_LATE',
        `Delivery ${candidate.taskId} would miss its promised time on this trip`,
      )
    }
    clock += Math.ceil((legMetres / speed) * 1_000) + serviceMs
    position = candidate.destination
  }
}

export const DeliveryTripState = {
  /** Being assembled. Drops may still join or leave. */
  PLANNED: 'PLANNED',
  /** Offered to a courier, or accepted by one. The sequence is now a promise. */
  DISPATCHED: 'DISPATCHED',
  /** Every drop reached a verdict, delivered or not. */
  COMPLETED: 'COMPLETED',
  /** Abandoned before dispatch, or unwound after it. */
  CANCELLED: 'CANCELLED',
} as const
export type DeliveryTripState = (typeof DeliveryTripState)[keyof typeof DeliveryTripState]

const TRIP_RULES: Readonly<Record<DeliveryTripState, readonly DeliveryTripState[]>> = {
  PLANNED: [DeliveryTripState.DISPATCHED, DeliveryTripState.CANCELLED],
  DISPATCHED: [DeliveryTripState.COMPLETED, DeliveryTripState.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
}

export function transitionDeliveryTrip(
  from: DeliveryTripState,
  to: DeliveryTripState,
): DeliveryTripState {
  if (!TRIP_RULES[from].includes(to)) {
    throw new DomainError('INVALID_TRIP_TRANSITION', `A trip cannot move from ${from} to ${to}`)
  }
  return to
}

/**
 * Whether a trip may still take on or give up drops.
 *
 * Once a courier has been offered the run, its sequence is what they are riding
 * and what every customer on it was promised. Adding a fourth drop to a rider
 * already at the second door does not shorten anything — it makes the last
 * customer late for a saving that has already been spent.
 */
export function tripAcceptsChanges(state: DeliveryTripState): boolean {
  return state === DeliveryTripState.PLANNED
}
