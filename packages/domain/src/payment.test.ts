import { describe, expect, it } from 'vitest'

import {
  initializePayment,
  orderPaymentStateFor,
  PaymentAggregateState,
  PaymentTransitionActor,
  transitionPayment,
} from './payment'

const base = {
  paymentId: 'payment-1',
  actor: PaymentTransitionActor.SYSTEM,
  idempotencyKey: 'payment-transition-0001',
  correlationId: 'correlation-1',
  occurredAt: new Date('2026-08-03T00:00:00.000Z'),
}

describe('payment aggregate', () => {
  it('initializes only positive integer IRR payments', () => {
    expect(
      initializePayment({
        orderId: 'order-1',
        customerId: 'customer-1',
        amount: 530_000n,
        currency: 'IRR',
        idempotencyKey: 'payment-command-0001',
        correlationId: 'correlation-1',
        occurredAt: base.occurredAt,
      }),
    ).toMatchObject({ amount: 530_000n, currency: 'IRR' })
    expect(() =>
      initializePayment({
        orderId: 'order-1',
        customerId: 'customer-1',
        amount: 0n,
        currency: 'IRR',
        idempotencyKey: 'payment-command-0002',
        correlationId: 'correlation-1',
        occurredAt: base.occurredAt,
      }),
    ).toThrow('positive amount')
  })

  it.each([
    [PaymentAggregateState.CREATED, PaymentAggregateState.PENDING],
    [PaymentAggregateState.PENDING, PaymentAggregateState.AUTHORIZED],
    [PaymentAggregateState.AUTHORIZED, PaymentAggregateState.CAPTURED],
    [PaymentAggregateState.CREATED, PaymentAggregateState.FAILED],
    [PaymentAggregateState.PENDING, PaymentAggregateState.FAILED],
    [PaymentAggregateState.AUTHORIZED, PaymentAggregateState.FAILED],
  ] as const)('allows the governed %s -> %s transition', (from, to) => {
    expect(transitionPayment({ ...base, from, to })).toMatchObject({ from, to })
  })

  it('rejects skipped, terminal, repeated, and customer-controlled transitions', () => {
    expect(() =>
      transitionPayment({
        ...base,
        from: PaymentAggregateState.CREATED,
        to: PaymentAggregateState.CAPTURED,
      }),
    ).toThrow('not allowed')
    expect(() =>
      transitionPayment({
        ...base,
        from: PaymentAggregateState.CAPTURED,
        to: PaymentAggregateState.FAILED,
      }),
    ).toThrow('not allowed')
    expect(() =>
      transitionPayment({
        ...base,
        actor: 'CUSTOMER' as PaymentTransitionActor,
        from: PaymentAggregateState.PENDING,
        to: PaymentAggregateState.AUTHORIZED,
      }),
    ).toThrow('cannot transition')
  })

  it('requires staff identity and maps aggregate state to the separate order dimension', () => {
    expect(() =>
      transitionPayment({
        ...base,
        actor: PaymentTransitionActor.STAFF,
        from: PaymentAggregateState.PENDING,
        to: PaymentAggregateState.FAILED,
      }),
    ).toThrow('actor ID')
    expect(orderPaymentStateFor(PaymentAggregateState.CREATED)).toBe('NOT_STARTED')
    expect(orderPaymentStateFor(PaymentAggregateState.AUTHORIZED)).toBe('PENDING')
    expect(orderPaymentStateFor(PaymentAggregateState.CAPTURED)).toBe('PAID')
  })
})
