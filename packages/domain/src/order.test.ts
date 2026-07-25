import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { asCorrelationId, asOrderId } from './ids'
import {
  OrderState,
  TransitionActor,
  canCancelOrder,
  terminalOrderStates,
  transitionOrder,
  type OrderStateTransition,
} from './order'

const base = {
  orderId: asOrderId('order_12345678'),
  occurredAt: new Date('2026-07-25T08:30:00.000Z'),
  idempotencyKey: 'transition_123',
  correlationId: asCorrelationId('correlation_12345678'),
}

const validTransitions: Array<Pick<OrderStateTransition, 'from' | 'to' | 'actor'>> = [
  { from: OrderState.DRAFT, to: OrderState.PENDING_CONFIRMATION, actor: TransitionActor.CUSTOMER },
  { from: OrderState.PENDING_CONFIRMATION, to: OrderState.CONFIRMED, actor: TransitionActor.STAFF },
  { from: OrderState.CONFIRMED, to: OrderState.IN_FULFILLMENT, actor: TransitionActor.BAKERY },
  { from: OrderState.IN_FULFILLMENT, to: OrderState.COMPLETED, actor: TransitionActor.SYSTEM },
]

describe('order transition policy', () => {
  it.each(validTransitions)('accepts an authorized transition', (transition) => {
    expect(transitionOrder({ ...base, ...transition })).toMatchObject(transition)
  })

  it('rejects invalid and unauthorized transitions', () => {
    expect(() =>
      transitionOrder({
        ...base,
        from: OrderState.DRAFT,
        to: OrderState.COMPLETED,
        actor: TransitionActor.SYSTEM,
      }),
    ).toThrowError(DomainError)
    expect(() =>
      transitionOrder({
        ...base,
        from: OrderState.PENDING_CONFIRMATION,
        to: OrderState.CONFIRMED,
        actor: TransitionActor.CUSTOMER,
      }),
    ).toThrowError(DomainError)
  })

  it('makes terminal states immutable and cancellation eligibility explicit', () => {
    expect(terminalOrderStates).toEqual(new Set([OrderState.COMPLETED, OrderState.CANCELLED]))
    expect(canCancelOrder(OrderState.CONFIRMED)).toBe(true)
    expect(canCancelOrder(OrderState.IN_FULFILLMENT)).toBe(false)
    expect(() =>
      transitionOrder({
        ...base,
        from: OrderState.COMPLETED,
        to: OrderState.CANCELLED,
        actor: TransitionActor.STAFF,
      }),
    ).toThrowError(DomainError)
  })
})
