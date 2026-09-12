import { describe, expect, it } from 'vitest'

import { isRetryablePaymentConflict } from './modules/payment-ledger'

/**
 * A unique violation in the shape Prisma 7 reports it, through the pg driver
 * adapter. The index name is nested under the adapter's cause and there is no
 * `meta.target` at all — which is how the readers below silently stopped
 * recognising their own races on the upgrade, with every fabricated-error unit
 * test still green because they all described the older shape.
 */
function uniqueViolation(index: string) {
  return {
    code: 'P2002',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          kind: 'UniqueConstraintViolation',
          originalCode: '23505',
          constraint: { index },
          table: 'Payment',
        },
      },
    },
  }
}

describe('payment transaction conflict classification', () => {
  it('recognizes Prisma and raw PostgreSQL serialization conflicts', () => {
    expect(isRetryablePaymentConflict({ code: 'P2034' })).toBe(true)
    expect(isRetryablePaymentConflict({ code: '40001' })).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2010', meta: { code: '23505' } })).toBe(false)
    expect(isRetryablePaymentConflict(new Error('serialization failed'))).toBe(false)
  })

  it('retries only identified payment idempotency and version uniqueness races', () => {
    expect(
      isRetryablePaymentConflict({
        code: 'P2002',
        meta: { target: ['tenantId', 'customerId', 'idempotencyKey'] },
      }),
    ).toBe(true)
    expect(
      isRetryablePaymentConflict({
        code: 'P2002',
        meta: { constraint: 'PaymentTransition_payment_version_key' },
      }),
    ).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2002' })).toBe(false)
    expect(
      isRetryablePaymentConflict({
        code: 'P2002',
        meta: { target: ['financialTransactionId', 'sequence'] },
      }),
    ).toBe(false)
    expect(
      isRetryablePaymentConflict({
        code: 'P2002',
        meta: { constraint: 'DomainEventOutbox_eventId_key' },
      }),
    ).toBe(false)
  })

  it('recognizes the same races in the shape the current client reports', () => {
    // The regression a review caught after the Prisma 7 upgrade: these are the
    // real indexes, named the way Postgres names them, and a loser on any of
    // them must converge on the first writer's result rather than escaping as a
    // raw database error to a customer who is being charged.
    for (const index of [
      'Payment_tenant_customer_idempotency_key',
      'Payment_orderId_key',
      'PaymentTransition_payment_version_key',
      'PaymentTransition_scoped_idempotency_key',
      'FinancialTransaction_paymentId_key',
      'FinancialTransaction_tenant_idempotency_key',
    ]) {
      expect(`${index}: ${isRetryablePaymentConflict(uniqueViolation(index))}`).toBe(
        `${index}: true`,
      )
    }

    // And still only those: an unrelated index is a genuine failure, not a race.
    expect(isRetryablePaymentConflict(uniqueViolation('DomainEventOutbox_eventId_key'))).toBe(false)
  })
})
