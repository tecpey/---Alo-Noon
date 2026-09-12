/**
 * Reading a database failure, whatever shape the client reports it in.
 *
 * Every write in this system that races another one — an idempotency key, a
 * one-active-challenge rule, a ledger account's version — is arbitrated by a
 * unique index, and the losing writer finds out by catching the violation and
 * asking *which* index it hit. Getting that answer wrong does not throw: it
 * returns "no idea", the caller stops recognising its own race, and a converged
 * request becomes a duplicate charge or a second OTP.
 *
 * That is exactly what the move to Prisma 7 did. The client kept reporting
 * `P2002`, so nothing looked broken, but the metadata underneath changed
 * shape entirely and every reader of it silently started returning nothing.
 * Nine integration tests caught it; no unit test could have, because they all
 * fabricate the error themselves.
 *
 * The shapes, all of which this understands:
 *
 *   Prisma 7, through a driver adapter — the index name, from Postgres:
 *     meta: { driverAdapterError: { cause: {
 *       kind: 'UniqueConstraintViolation',
 *       constraint: { index: 'PaymentAttempt_tenant_idempotency_key' },
 *       table: 'PaymentAttempt', originalCode: '23505' } } }
 *
 *   Prisma 5 and 6 — the model's *field names*, not the index's:
 *     meta: { target: ['tenantId', 'requestIdempotencyKey'] }
 *
 *   Prisma 5 and 6 on a raw query, and some providers — the name, as a string:
 *     meta: { constraint: 'LedgerGovernance_account_version_key' }
 *
 * Lives in this package because it is knowledge about Prisma, and this package
 * is the only one that depends on Prisma. The alternative was the three
 * near-identical copies in `apps/api/src/modules` that this replaces, which had
 * already drifted apart from one another before any of them went stale.
 */

/** A database failure, normalised. Every field is absent when unknown. */
export interface DatabaseFailure {
  /** Prisma's own code — `P2002` for a unique violation, `P2034` for a deadlock. */
  code?: string
  /**
   * The SQLSTATE Postgres itself raised, when the driver reported one.
   *
   * Worth having separately from `code`: version 7 reports a raw statement that
   * failed as `P2010` whatever went wrong underneath, so the serialization
   * failure (`40001`) and the check violation (`23514`) that used to be
   * distinguishable by Prisma's code are now only distinguishable by this.
   */
  sqlState?: string
  /** The unique index the write collided with, as Postgres names it. */
  constraint?: string
  /** The table it is defined on, when reported. */
  table?: string
  /** The model's field names — reported by Prisma 5 and 6, never by 7. */
  fields?: readonly string[]
}

function get(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Everything worth knowing about a thrown database error.
 *
 * Duck-typed rather than `instanceof`: the generated client is a different
 * module instance in a test than in the process under test, and an
 * `instanceof PrismaClientKnownRequestError` that quietly returns false is the
 * same silent failure this whole file exists to prevent.
 */
export function readDatabaseFailure(error: unknown): DatabaseFailure {
  if (!error || typeof error !== 'object') return {}

  const meta = get(error, 'meta')
  const cause = get(get(meta, 'driverAdapterError'), 'cause')

  const failure: DatabaseFailure = {}

  const code = asString(get(error, 'code'))
  if (code) failure.code = code

  // `originalCode` is what the adapter names it for a violation it recognised;
  // `code` is what it carries for one it passed through untouched.
  const sqlState =
    asString(get(cause, 'originalCode')) ??
    asString(get(cause, 'code')) ??
    // Pre-7 raw failures put the SQLSTATE directly on the meta.
    asString(get(meta, 'code'))
  if (sqlState) failure.sqlState = sqlState

  const constraint =
    asString(get(get(cause, 'constraint'), 'index')) ??
    asString(get(cause, 'constraint')) ??
    asString(get(meta, 'constraint')) ??
    // Prisma 5 occasionally reported the index name in `target` as a bare
    // string rather than an array of fields.
    (Array.isArray(get(meta, 'target')) ? undefined : asString(get(meta, 'target')))
  if (constraint) failure.constraint = constraint

  const table = asString(get(cause, 'table')) ?? asString(get(meta, 'modelName'))
  if (table) failure.table = table

  const target = get(meta, 'target')
  if (Array.isArray(target)) {
    const fields = target.filter((value): value is string => typeof value === 'string')
    if (fields.length > 0) failure.fields = fields
  }

  return failure
}

/**
 * Whether a failure is the kind worth trying again.
 *
 * A serialization failure or a deadlock means the database refused to guess
 * between two transactions, not that the request was wrong — the caller retries
 * and one of them wins. Distinguishing it from a genuine constraint violation
 * is the difference between a converged request and a failed one.
 */
export function isRetryableDatabaseFailure(error: unknown): boolean {
  const { code, sqlState } = readDatabaseFailure(error)
  // P2034 is Prisma's own. 40001 is `serialization_failure` and 40P01 is
  // `deadlock_detected`; those reach us as a nested SQLSTATE now that a raw
  // statement comes back as P2010 whatever went wrong underneath, and as a bare
  // `code` when a driver puts the SQLSTATE there directly.
  const serialization = (value?: string) => value === '40001' || value === '40P01'
  return code === 'P2034' || serialization(sqlState) || serialization(code)
}
