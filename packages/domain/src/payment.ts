import { DomainError } from './errors'

export const PaymentAggregateState = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
} as const
export type PaymentAggregateState =
  (typeof PaymentAggregateState)[keyof typeof PaymentAggregateState]

export const PaymentTransitionActor = {
  SYSTEM: 'SYSTEM',
  STAFF: 'STAFF',
} as const
export type PaymentTransitionActor =
  (typeof PaymentTransitionActor)[keyof typeof PaymentTransitionActor]

export interface PaymentInitialization {
  orderId: string
  customerId: string
  amount: bigint
  currency: 'IRR'
  idempotencyKey: string
  correlationId: string
  occurredAt: Date
}

export interface PaymentTransition {
  paymentId: string
  from: PaymentAggregateState
  to: PaymentAggregateState
  actor: PaymentTransitionActor
  actorId?: string
  idempotencyKey: string
  correlationId: string
  occurredAt: Date
}

type TransitionRule = Readonly<{
  to: PaymentAggregateState
  actors: readonly PaymentTransitionActor[]
}>

const rules: Readonly<Record<PaymentAggregateState, readonly TransitionRule[]>> = {
  CREATED: [
    { to: PaymentAggregateState.PENDING, actors: [PaymentTransitionActor.SYSTEM] },
    {
      to: PaymentAggregateState.FAILED,
      actors: [PaymentTransitionActor.SYSTEM, PaymentTransitionActor.STAFF],
    },
  ],
  PENDING: [
    { to: PaymentAggregateState.AUTHORIZED, actors: [PaymentTransitionActor.SYSTEM] },
    {
      to: PaymentAggregateState.FAILED,
      actors: [PaymentTransitionActor.SYSTEM, PaymentTransitionActor.STAFF],
    },
  ],
  AUTHORIZED: [
    { to: PaymentAggregateState.CAPTURED, actors: [PaymentTransitionActor.SYSTEM] },
    {
      to: PaymentAggregateState.FAILED,
      actors: [PaymentTransitionActor.SYSTEM, PaymentTransitionActor.STAFF],
    },
  ],
  CAPTURED: [],
  FAILED: [],
}

export function initializePayment(input: PaymentInitialization): Readonly<PaymentInitialization> {
  assertPaymentCommand(input.idempotencyKey, input.correlationId, input.occurredAt)
  if (!input.orderId.trim() || !input.customerId.trim() || input.amount <= 0n) {
    throw new DomainError(
      'INVALID_PAYMENT_INITIALIZATION',
      'Payment initialization requires an order, customer, and positive amount',
    )
  }
  if (input.currency !== 'IRR') {
    throw new DomainError('INVALID_PAYMENT_CURRENCY', 'Only integer IRR payments are supported')
  }
  return Object.freeze({ ...input })
}

export function transitionPayment(input: PaymentTransition): Readonly<PaymentTransition> {
  assertPaymentCommand(input.idempotencyKey, input.correlationId, input.occurredAt)
  if (!input.paymentId.trim()) {
    throw new DomainError('INVALID_PAYMENT_TRANSITION', 'Payment transition requires a payment')
  }
  const rule = rules[input.from].find((candidate) => candidate.to === input.to)
  if (!rule) {
    throw new DomainError(
      'INVALID_PAYMENT_TRANSITION',
      `Payment transition from ${input.from} to ${input.to} is not allowed`,
    )
  }
  if (!rule.actors.includes(input.actor)) {
    throw new DomainError(
      'UNAUTHORIZED_PAYMENT_TRANSITION',
      `${input.actor} cannot transition a payment from ${input.from} to ${input.to}`,
    )
  }
  if (input.actor === PaymentTransitionActor.STAFF && !input.actorId?.trim()) {
    throw new DomainError(
      'UNAUTHORIZED_PAYMENT_TRANSITION',
      'Staff payment transitions require an actor ID',
    )
  }
  return Object.freeze({ ...input })
}

export function orderPaymentStateFor(
  state: PaymentAggregateState,
): 'NOT_STARTED' | 'PENDING' | 'PAID' {
  switch (state) {
    case PaymentAggregateState.CREATED:
    case PaymentAggregateState.FAILED:
      return 'NOT_STARTED'
    case PaymentAggregateState.PENDING:
    case PaymentAggregateState.AUTHORIZED:
      return 'PENDING'
    case PaymentAggregateState.CAPTURED:
      return 'PAID'
  }
}

function assertPaymentCommand(
  idempotencyKey: string,
  correlationId: string,
  occurredAt: Date,
): void {
  if (
    idempotencyKey.trim().length < 16 ||
    idempotencyKey.length > 128 ||
    !correlationId.trim() ||
    Number.isNaN(occurredAt.getTime())
  ) {
    throw new DomainError(
      'INVALID_PAYMENT_COMMAND',
      'Payment commands require idempotency, correlation, and a valid timestamp',
    )
  }
}
