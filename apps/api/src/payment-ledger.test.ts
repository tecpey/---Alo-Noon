import { describe, expect, it } from 'vitest'

import { isRetryablePaymentConflict } from './modules/payment-ledger'

describe('payment transaction conflict classification', () => {
  it('recognizes Prisma and raw PostgreSQL serialization conflicts', () => {
    expect(isRetryablePaymentConflict({ code: 'P2034' })).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2002' })).toBe(true)
    expect(isRetryablePaymentConflict({ code: '40001' })).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
    expect(isRetryablePaymentConflict({ code: 'P2010', meta: { code: '23505' } })).toBe(false)
    expect(isRetryablePaymentConflict(new Error('serialization failed'))).toBe(false)
  })
})
