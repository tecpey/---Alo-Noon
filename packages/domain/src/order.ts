import { DomainError } from './errors'
import type { CorrelationId, OrderId } from './ids'

export const OrderState = {
  DRAFT: 'DRAFT',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
  IN_FULFILLMENT: 'IN_FULFILLMENT',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const
export type OrderState = (typeof OrderState)[keyof typeof OrderState]

export const PaymentState = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING: 'PENDING',
  PAID: 'PAID',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
} as const
export type PaymentState = (typeof PaymentState)[keyof typeof PaymentState]

export const ProductionState = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  UNSCHEDULED: 'UNSCHEDULED',
  SCHEDULED: 'SCHEDULED',
  IN_PRODUCTION: 'IN_PRODUCTION',
  READY: 'READY',
  HANDED_OFF: 'HANDED_OFF',
} as const
export type ProductionState = (typeof ProductionState)[keyof typeof ProductionState]

export const DeliveryState = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  UNASSIGNED: 'UNASSIGNED',
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
} as const
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState]

export const TransitionActor = {
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
  BAKERY: 'BAKERY',
  COURIER: 'COURIER',
  SYSTEM: 'SYSTEM',
} as const
export type TransitionActor = (typeof TransitionActor)[keyof typeof TransitionActor]

export interface OrderStateTransition {
  orderId: OrderId
  from: OrderState
  to: OrderState
  actor: TransitionActor
  occurredAt: Date
  reason?: string
  idempotencyKey: string
  correlationId: CorrelationId
}

type TransitionRule = Readonly<{ to: OrderState; actors: readonly TransitionActor[] }>

const transitionRules: Readonly<Record<OrderState, readonly TransitionRule[]>> = {
  DRAFT: [
    {
      to: OrderState.PENDING_CONFIRMATION,
      actors: [TransitionActor.CUSTOMER, TransitionActor.STAFF],
    },
    { to: OrderState.CANCELLED, actors: [TransitionActor.CUSTOMER, TransitionActor.STAFF] },
  ],
  PENDING_CONFIRMATION: [
    { to: OrderState.CONFIRMED, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
    { to: OrderState.CANCEL_REQUESTED, actors: [TransitionActor.CUSTOMER] },
    { to: OrderState.CANCELLED, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
  ],
  CONFIRMED: [
    {
      to: OrderState.IN_FULFILLMENT,
      actors: [TransitionActor.STAFF, TransitionActor.BAKERY, TransitionActor.SYSTEM],
    },
    {
      to: OrderState.CANCEL_REQUESTED,
      actors: [TransitionActor.CUSTOMER, TransitionActor.STAFF],
    },
    { to: OrderState.CANCELLED, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
  ],
  IN_FULFILLMENT: [
    { to: OrderState.COMPLETED, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
    {
      to: OrderState.DELIVERY_FAILED,
      actors: [TransitionActor.COURIER, TransitionActor.STAFF, TransitionActor.SYSTEM],
    },
    { to: OrderState.CANCEL_REQUESTED, actors: [TransitionActor.STAFF] },
  ],
  CANCEL_REQUESTED: [
    { to: OrderState.CANCELLED, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
    { to: OrderState.CONFIRMED, actors: [TransitionActor.STAFF] },
    { to: OrderState.IN_FULFILLMENT, actors: [TransitionActor.STAFF] },
  ],
  DELIVERY_FAILED: [
    { to: OrderState.IN_FULFILLMENT, actors: [TransitionActor.STAFF, TransitionActor.SYSTEM] },
    { to: OrderState.CANCEL_REQUESTED, actors: [TransitionActor.STAFF] },
  ],
  COMPLETED: [],
  CANCELLED: [],
}

export const terminalOrderStates: ReadonlySet<OrderState> = new Set([
  OrderState.COMPLETED,
  OrderState.CANCELLED,
])

export function transitionOrder(input: OrderStateTransition): OrderStateTransition {
  if (!input.idempotencyKey.trim()) {
    throw new DomainError(
      'INVALID_ORDER_TRANSITION',
      'Order transition requires an idempotency key',
    )
  }
  if (terminalOrderStates.has(input.from)) {
    throw new DomainError('INVALID_ORDER_TRANSITION', `${input.from} is a terminal order state`)
  }
  const matchingRule = transitionRules[input.from].find((rule) => rule.to === input.to)
  if (!matchingRule) {
    throw new DomainError(
      'INVALID_ORDER_TRANSITION',
      `Transition from ${input.from} to ${input.to} is not allowed`,
    )
  }
  if (!matchingRule.actors.includes(input.actor)) {
    throw new DomainError(
      'UNAUTHORIZED_ORDER_TRANSITION',
      `${input.actor} cannot transition an order from ${input.from} to ${input.to}`,
    )
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    throw new DomainError('INVALID_ORDER_TRANSITION', 'Transition timestamp must be valid')
  }
  return Object.freeze(input)
}

export function canCancelOrder(state: OrderState): boolean {
  const cancellableStates: readonly OrderState[] = [
    OrderState.DRAFT,
    OrderState.PENDING_CONFIRMATION,
    OrderState.CONFIRMED,
    OrderState.CANCEL_REQUESTED,
    OrderState.DELIVERY_FAILED,
  ]
  return cancellableStates.includes(state)
}

/**
 * How a batch of bread moves through a bakery.
 *
 * Separate from the order's own state because they answer different questions
 * and move at different speeds: an order is CONFIRMED the moment the bakery
 * accepts it, but the bread is not scheduled, baking, or ready until it is. A
 * customer asking "where is my order" is asking this one.
 *
 * `NOT_REQUIRED` is for orders that carry nothing a bakery produces — packaged
 * goods pulled from stock. It is a starting state, not somewhere production
 * arrives at.
 */
const productionRules: Readonly<Record<ProductionState, readonly ProductionState[]>> = {
  NOT_REQUIRED: [],
  UNSCHEDULED: [ProductionState.SCHEDULED, ProductionState.IN_PRODUCTION],
  SCHEDULED: [ProductionState.IN_PRODUCTION, ProductionState.UNSCHEDULED],
  IN_PRODUCTION: [ProductionState.READY],
  READY: [ProductionState.HANDED_OFF],
  HANDED_OFF: [],
}

/**
 * Which actors may move production at all.
 *
 * A courier appears only at hand-off: taking the bread is the one production
 * fact a courier is in a position to assert, and it is exactly the moment
 * responsibility for it changes hands.
 */
const productionActors: Readonly<Record<ProductionState, readonly TransitionActor[]>> = {
  NOT_REQUIRED: [],
  UNSCHEDULED: [TransitionActor.BAKERY, TransitionActor.STAFF],
  SCHEDULED: [TransitionActor.BAKERY, TransitionActor.STAFF],
  IN_PRODUCTION: [TransitionActor.BAKERY, TransitionActor.STAFF],
  READY: [TransitionActor.BAKERY, TransitionActor.STAFF],
  HANDED_OFF: [TransitionActor.BAKERY, TransitionActor.COURIER, TransitionActor.STAFF],
}

export interface ProductionTransition {
  from: ProductionState
  to: ProductionState
  actor: TransitionActor
}

/**
 * Validates a production step, or explains why it is not one.
 *
 * Going backwards is refused rather than tolerated: bread that was READY and is
 * suddenly IN_PRODUCTION again is either a mistake or a second batch, and a
 * second batch is a different order line. The one exception is SCHEDULED back
 * to UNSCHEDULED, which is a bakery releasing a slot it cannot fill — a real
 * thing that happens, and better recorded than worked around.
 */
export function transitionProduction(input: ProductionTransition): ProductionTransition {
  if (input.from === input.to) {
    throw new DomainError('INVALID_PRODUCTION_TRANSITION', 'Production state is already set')
  }
  if (!productionRules[input.from].includes(input.to)) {
    throw new DomainError(
      'INVALID_PRODUCTION_TRANSITION',
      `Production cannot move from ${input.from} to ${input.to}`,
    )
  }
  if (!productionActors[input.to].includes(input.actor)) {
    throw new DomainError(
      'UNAUTHORIZED_PRODUCTION_TRANSITION',
      `${input.actor} cannot move production to ${input.to}`,
    )
  }
  return Object.freeze(input)
}

/**
 * Whether an order is far enough along that production applies to it.
 *
 * Before a bakery accepts, there is nothing to bake; after the order is
 * cancelled or complete, there is nothing left to bake either.
 */
export function productionApplies(state: OrderState): boolean {
  return state === OrderState.CONFIRMED || state === OrderState.IN_FULFILLMENT
}
