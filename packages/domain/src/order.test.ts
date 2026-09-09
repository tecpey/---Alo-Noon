import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { asCorrelationId, asOrderId } from './ids'
import {
  OrderState,
  ProductionState,
  TransitionActor,
  canCancelOrder,
  productionApplies,
  terminalOrderStates,
  transitionOrder,
  transitionProduction,
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

describe('production state machine', () => {
  it('walks a batch from unscheduled to handed off', () => {
    const path: ReadonlyArray<[ProductionState, ProductionState]> = [
      [ProductionState.UNSCHEDULED, ProductionState.SCHEDULED],
      [ProductionState.SCHEDULED, ProductionState.IN_PRODUCTION],
      [ProductionState.IN_PRODUCTION, ProductionState.READY],
      [ProductionState.READY, ProductionState.HANDED_OFF],
    ]
    for (const [from, to] of path) {
      expect(transitionProduction({ from, to, actor: TransitionActor.BAKERY })).toMatchObject({
        from,
        to,
      })
    }
  })

  it('refuses to move production backwards', () => {
    expect(() =>
      transitionProduction({
        from: ProductionState.READY,
        to: ProductionState.IN_PRODUCTION,
        actor: TransitionActor.STAFF,
      }),
    ).toThrow(DomainError)
  })

  it('lets a bakery release a slot it cannot fill', () => {
    // The one backwards step that is a real event rather than a mistake.
    expect(
      transitionProduction({
        from: ProductionState.SCHEDULED,
        to: ProductionState.UNSCHEDULED,
        actor: TransitionActor.BAKERY,
      }),
    ).toMatchObject({ to: ProductionState.UNSCHEDULED })
  })

  it('lets a courier assert hand-off and nothing else', () => {
    expect(
      transitionProduction({
        from: ProductionState.READY,
        to: ProductionState.HANDED_OFF,
        actor: TransitionActor.COURIER,
      }),
    ).toMatchObject({ actor: TransitionActor.COURIER })

    expect(() =>
      transitionProduction({
        from: ProductionState.UNSCHEDULED,
        to: ProductionState.SCHEDULED,
        actor: TransitionActor.COURIER,
      }),
    ).toThrow(DomainError)
  })

  it('treats a terminal production state as terminal', () => {
    expect(() =>
      transitionProduction({
        from: ProductionState.HANDED_OFF,
        to: ProductionState.READY,
        actor: TransitionActor.STAFF,
      }),
    ).toThrow(DomainError)
    // Nothing a bakery produces, so nothing to move.
    expect(() =>
      transitionProduction({
        from: ProductionState.NOT_REQUIRED,
        to: ProductionState.SCHEDULED,
        actor: TransitionActor.STAFF,
      }),
    ).toThrow(DomainError)
  })

  it('applies production only while an order is live', () => {
    expect(productionApplies(OrderState.CONFIRMED)).toBe(true)
    expect(productionApplies(OrderState.IN_FULFILLMENT)).toBe(true)
    expect(productionApplies(OrderState.PENDING_CONFIRMATION)).toBe(false)
    expect(productionApplies(OrderState.CANCELLED)).toBe(false)
  })
})
