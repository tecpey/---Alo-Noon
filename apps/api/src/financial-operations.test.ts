import { describe, expect, it } from 'vitest'

import { isRetryableFinancialOperationsConflict } from './modules/financial-operations'

describe('financial operations transaction conflict classification', () => {
  it('retries serialization conflicts and only exact governance uniqueness races', () => {
    expect(isRetryableFinancialOperationsConflict({ code: 'P2034' })).toBe(true)
    expect(isRetryableFinancialOperationsConflict({ code: '40001' })).toBe(true)
    expect(isRetryableFinancialOperationsConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(
      true,
    )
    expect(
      isRetryableFinancialOperationsConflict({
        code: 'P2002',
        meta: { target: ['tenantId', 'idempotencyKey'] },
      }),
    ).toBe(true)
    expect(
      isRetryableFinancialOperationsConflict({
        code: 'P2002',
        meta: { constraint: 'LedgerGovernance_account_version_key' },
      }),
    ).toBe(true)
    expect(isRetryableFinancialOperationsConflict({ code: 'P2002' })).toBe(false)
    expect(isRetryableFinancialOperationsConflict({ code: 'P2010', meta: { code: '23505' } })).toBe(
      false,
    )
  })

  it('recognizes the same races in the shape the current client reports', () => {
    // Prisma 7 puts the index name in a nested driver-adapter cause and leaves
    // `meta.target` absent entirely. Reading only the older shape — which this
    // did until a review caught it — meant two governance requests racing on a
    // ledger account's version stopped being retried and the caller received an
    // unnormalized database failure.
    const uniqueViolation = (index: string) => ({
      code: 'P2002',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'UniqueConstraintViolation',
            originalCode: '23505',
            constraint: { index },
            table: 'LedgerGovernance',
          },
        },
      },
    })

    for (const index of [
      'LedgerGovernance_tenant_idempotency_key',
      'LedgerGovernance_account_version_key',
    ]) {
      expect(`${index}: ${isRetryableFinancialOperationsConflict(uniqueViolation(index))}`).toBe(
        `${index}: true`,
      )
    }

    expect(isRetryableFinancialOperationsConflict(uniqueViolation('LedgerEntry_pkey'))).toBe(false)
  })
})
