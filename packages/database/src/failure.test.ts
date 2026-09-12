import { describe, expect, it } from 'vitest'

import { isRetryableDatabaseFailure, readDatabaseFailure } from './failure'

/**
 * The shapes are real, copied out of a running client rather than imagined.
 *
 * That matters more here than usual. Every reader of this metadata in the API
 * is a race arbitrator — an idempotency key, a one-active-challenge rule, a
 * ledger account's version — and when one of them stops recognising its own
 * constraint it does not throw. It returns "no idea", the caller stops treating
 * a converged request as converged, and the failure surfaces as a duplicate
 * charge rather than as an error. Prisma 7 changed the shape and nine
 * integration tests caught it; none of the unit tests could, because they all
 * fabricated the error themselves in the shape they already believed in.
 */

/** Prisma 7, through `@prisma/adapter-pg`. Printed from a real violation. */
const PRISMA_7_UNIQUE = {
  code: 'P2002',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        originalMessage: 'duplicate key value violates unique constraint "Tenant_slug_key"',
        kind: 'UniqueConstraintViolation',
        constraint: { index: 'Tenant_slug_key' },
        table: 'Tenant',
      },
    },
    modelName: 'Tenant',
  },
}

/** Prisma 7, a raw statement that failed: P2010 whatever went wrong beneath. */
const PRISMA_7_RAW = {
  code: 'P2010',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: { kind: 'postgres', code: '40001', severity: 'ERROR', message: 'could not serialize' },
    },
  },
}

describe('reading a unique violation', () => {
  it('finds the index by name in the shape version 7 reports', () => {
    expect(readDatabaseFailure(PRISMA_7_UNIQUE)).toEqual({
      code: 'P2002',
      sqlState: '23505',
      constraint: 'Tenant_slug_key',
      table: 'Tenant',
    })
  })

  it('still reads the field list versions 5 and 6 reported instead', () => {
    // Those versions never named the index — they named the model's columns and
    // left the caller to work out which constraint that was. Kept because the
    // API's unit tests fabricate errors in this shape, and because a rollback
    // to Prisma 5 should not silently disarm every race check in the system.
    expect(
      readDatabaseFailure({ code: 'P2002', meta: { target: ['tenantId', 'mobileDigest'] } }),
    ).toEqual({
      code: 'P2002',
      fields: ['tenantId', 'mobileDigest'],
    })
  })

  it('reads the bare constraint name some paths report', () => {
    expect(
      readDatabaseFailure({
        code: 'P2002',
        meta: { constraint: 'LedgerGovernance_account_version_key' },
      }),
    ).toEqual({ code: 'P2002', constraint: 'LedgerGovernance_account_version_key' })
  })

  it('says nothing rather than guessing, when handed something else', () => {
    // The dangerous direction is inventing a constraint name that matches one
    // of the allow-lists. Silence is recoverable; a wrong match is not.
    for (const value of [null, undefined, 'a string', 42, {}, { meta: null }, new Error('plain')]) {
      expect(readDatabaseFailure(value).constraint).toBeUndefined()
    }
  })
})

describe('deciding whether to try again', () => {
  it('retries a serialization failure however the client reports it', () => {
    // Prisma's own code, the nested SQLSTATE that version 7 buries under P2010,
    // and the bare code some drivers put on the error directly.
    expect(isRetryableDatabaseFailure({ code: 'P2034' })).toBe(true)
    expect(isRetryableDatabaseFailure(PRISMA_7_RAW)).toBe(true)
    expect(isRetryableDatabaseFailure({ code: '40001' })).toBe(true)
    expect(isRetryableDatabaseFailure({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
  })

  it('retries a detected deadlock, which Postgres reports separately', () => {
    expect(
      isRetryableDatabaseFailure({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { code: '40P01' } } },
      }),
    ).toBe(true)
  })

  it('does not retry a constraint violation, which will fail again identically', () => {
    expect(isRetryableDatabaseFailure(PRISMA_7_UNIQUE)).toBe(false)
    expect(isRetryableDatabaseFailure({ code: 'P2002' })).toBe(false)
    // A check violation is the database refusing the data, not refusing to
    // choose between two transactions.
    expect(
      isRetryableDatabaseFailure({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { code: '23514' } } },
      }),
    ).toBe(false)
    expect(isRetryableDatabaseFailure(new Error('network went away'))).toBe(false)
  })
})
