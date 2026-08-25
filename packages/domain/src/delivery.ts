import { DomainError } from './errors'
import { DeliveryState, TransitionActor } from './order'

/**
 * Getting the bread from the bakery to the door.
 *
 * The schema has carried these states since the beginning with no code behind
 * them, which meant the rules lived nowhere: any state could follow any other.
 * They are here rather than in the service for the same reason the order rules
 * are — a courier tapping the wrong button and a dispatcher clicking the wrong
 * row have to be refused by the same sentence, and that sentence has to be
 * testable without a database.
 *
 * The division of labour is the interesting part. A dispatcher decides *who*
 * delivers; a courier reports *what happened*. Neither may do the other's job:
 * a dispatcher who could mark a delivery complete could close an order for
 * bread still sitting on a shelf, and a courier who could reassign work could
 * take an order off a colleague mid-route.
 */
export const DeliveryTaskState = {
  UNASSIGNED: 'UNASSIGNED',
  ASSIGNMENT_PENDING: 'ASSIGNMENT_PENDING',
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const
export type DeliveryTaskState = (typeof DeliveryTaskState)[keyof typeof DeliveryTaskState]

export const DeliveryAssignmentState = {
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const
export type DeliveryAssignmentState =
  (typeof DeliveryAssignmentState)[keyof typeof DeliveryAssignmentState]

/**
 * A rejected offer returns the task to UNASSIGNED rather than ending it. One
 * courier saying no is not the delivery failing; it is the dispatcher's next
 * problem, and the order is still owed to someone.
 *
 * FAILED is not terminal for the same reason: nobody home at four o'clock is a
 * reason to try again at six, not a reason to keep the customer's money and
 * their bread.
 */
const TASK_RULES: Readonly<Record<DeliveryTaskState, readonly DeliveryTaskState[]>> = {
  UNASSIGNED: [DeliveryTaskState.ASSIGNMENT_PENDING, DeliveryTaskState.CANCELLED],
  ASSIGNMENT_PENDING: [
    DeliveryTaskState.ASSIGNED,
    DeliveryTaskState.UNASSIGNED,
    DeliveryTaskState.CANCELLED,
  ],
  ASSIGNED: [
    DeliveryTaskState.PICKED_UP,
    DeliveryTaskState.UNASSIGNED,
    DeliveryTaskState.CANCELLED,
  ],
  PICKED_UP: [
    DeliveryTaskState.OUT_FOR_DELIVERY,
    DeliveryTaskState.FAILED,
    DeliveryTaskState.CANCELLED,
  ],
  OUT_FOR_DELIVERY: [DeliveryTaskState.DELIVERED, DeliveryTaskState.FAILED],
  FAILED: [DeliveryTaskState.UNASSIGNED, DeliveryTaskState.CANCELLED],
  DELIVERED: [],
  CANCELLED: [],
}

/**
 * Who may assert each state.
 *
 * A courier may not put a task back to UNASSIGNED: dropping work is a
 * conversation with a dispatcher, not a button, and a task silently returned to
 * the pool at the moment it was due is how an order goes quiet. A dispatcher
 * may not assert PICKED_UP or DELIVERED, because only the person holding the
 * bag knows either.
 */
const TASK_ACTORS: Readonly<Record<DeliveryTaskState, readonly TransitionActor[]>> = {
  UNASSIGNED: [TransitionActor.STAFF],
  ASSIGNMENT_PENDING: [TransitionActor.STAFF],
  ASSIGNED: [TransitionActor.COURIER],
  PICKED_UP: [TransitionActor.COURIER],
  OUT_FOR_DELIVERY: [TransitionActor.COURIER],
  DELIVERED: [TransitionActor.COURIER],
  FAILED: [TransitionActor.COURIER],
  // Cancelling is the order's decision reaching the delivery, never the
  // courier's own; SYSTEM is how an order cancellation propagates.
  CANCELLED: [TransitionActor.STAFF, TransitionActor.SYSTEM],
}

export interface DeliveryTaskTransition {
  from: DeliveryTaskState
  to: DeliveryTaskState
  actor: TransitionActor
}

export function transitionDeliveryTask(input: DeliveryTaskTransition): DeliveryTaskTransition {
  if (input.from === input.to) {
    throw new DomainError('INVALID_DELIVERY_TRANSITION', 'The delivery is already in that state')
  }
  if (!TASK_RULES[input.from].includes(input.to)) {
    throw new DomainError(
      'INVALID_DELIVERY_TRANSITION',
      `A delivery cannot move from ${input.from} to ${input.to}`,
    )
  }
  if (!TASK_ACTORS[input.to].includes(input.actor)) {
    throw new DomainError(
      'UNAUTHORIZED_DELIVERY_TRANSITION',
      `${input.actor} cannot move a delivery to ${input.to}`,
    )
  }
  return Object.freeze(input)
}

const ASSIGNMENT_RULES: Readonly<
  Record<DeliveryAssignmentState, readonly DeliveryAssignmentState[]>
> = {
  OFFERED: [
    DeliveryAssignmentState.ACCEPTED,
    DeliveryAssignmentState.REJECTED,
    DeliveryAssignmentState.CANCELLED,
  ],
  ACCEPTED: [DeliveryAssignmentState.COMPLETED, DeliveryAssignmentState.CANCELLED],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
}

const ASSIGNMENT_ACTORS: Readonly<Record<DeliveryAssignmentState, readonly TransitionActor[]>> = {
  OFFERED: [TransitionActor.STAFF],
  ACCEPTED: [TransitionActor.COURIER],
  REJECTED: [TransitionActor.COURIER],
  // Withdrawing an offer is the dispatcher's; completing one follows the task
  // being delivered, which is why the system asserts it rather than a person.
  CANCELLED: [TransitionActor.STAFF, TransitionActor.SYSTEM],
  COMPLETED: [TransitionActor.SYSTEM],
}

export interface DeliveryAssignmentTransition {
  from: DeliveryAssignmentState
  to: DeliveryAssignmentState
  actor: TransitionActor
}

export function transitionDeliveryAssignment(
  input: DeliveryAssignmentTransition,
): DeliveryAssignmentTransition {
  if (input.from === input.to) {
    throw new DomainError('INVALID_DELIVERY_TRANSITION', 'The assignment is already in that state')
  }
  if (!ASSIGNMENT_RULES[input.from].includes(input.to)) {
    throw new DomainError(
      'INVALID_DELIVERY_TRANSITION',
      `An assignment cannot move from ${input.from} to ${input.to}`,
    )
  }
  if (!ASSIGNMENT_ACTORS[input.to].includes(input.actor)) {
    throw new DomainError(
      'UNAUTHORIZED_DELIVERY_TRANSITION',
      `${input.actor} cannot move an assignment to ${input.to}`,
    )
  }
  return Object.freeze(input)
}

/**
 * What the order should say while its delivery is in a given state.
 *
 * The order carries its own `deliveryState` so a customer reading their order
 * does not have to be shown the dispatcher's task board. Deriving it here rather
 * than setting it at each call site is what keeps the two from disagreeing —
 * and an order whose delivery says DELIVERED while the order says OUT_FOR_DELIVERY
 * is a support call nobody can answer.
 *
 * ASSIGNMENT_PENDING maps to UNASSIGNED on purpose: an offer nobody has accepted
 * is not an assignment, and telling a customer their order is assigned while a
 * courier is still deciding would be a promise made on their behalf.
 */
export function orderDeliveryStateFor(state: DeliveryTaskState): DeliveryState {
  switch (state) {
    case DeliveryTaskState.UNASSIGNED:
    case DeliveryTaskState.ASSIGNMENT_PENDING:
    case DeliveryTaskState.CANCELLED:
      return DeliveryState.UNASSIGNED
    case DeliveryTaskState.ASSIGNED:
      return DeliveryState.ASSIGNED
    case DeliveryTaskState.PICKED_UP:
      return DeliveryState.PICKED_UP
    case DeliveryTaskState.OUT_FOR_DELIVERY:
      return DeliveryState.OUT_FOR_DELIVERY
    case DeliveryTaskState.DELIVERED:
      return DeliveryState.DELIVERED
    case DeliveryTaskState.FAILED:
      return DeliveryState.FAILED
  }
}

/** A task in one of these is finished with; nothing more will happen to it. */
export function deliveryTaskIsTerminal(state: DeliveryTaskState): boolean {
  return TASK_RULES[state].length === 0
}

/**
 * Whether a courier may be offered work.
 *
 * Deliberately narrower than "not suspended": a courier still onboarding has
 * not finished whatever the operator needs them to finish, and one marked
 * unavailable has said they are not working. Offering either of them an order
 * is an order that sits.
 */
export function courierCanBeOffered(status: string): boolean {
  return status === 'AVAILABLE'
}
