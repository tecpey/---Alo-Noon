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
})
