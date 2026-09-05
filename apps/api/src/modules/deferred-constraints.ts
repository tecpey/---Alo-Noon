import type { Prisma } from '@alo-noon/database'

/**
 * Forces every deferred constraint to be checked before the transaction ends.
 *
 * This exists because of a defect in the client, not in the database.
 *
 * Several of this schema's guarantees are deferred constraint triggers: the
 * double-entry balance guard cannot run when the transaction row is inserted,
 * because its entries do not exist yet, so it runs at COMMIT. PostgreSQL
 * raises there and rolls the whole transaction back, correctly.
 *
 * Prisma 5.22 does not report that error. An interactive `$transaction` whose
 * COMMIT is refused by a trigger's RAISE resolves as though it succeeded — the
 * database is left consistent, because nothing was written, but the caller is
 * told the opposite of the truth. For money that is the worst possible failure
 * mode: a settlement run believes it captured a payment, an order is treated as
 * paid, a customer is told their balance went up, and no row anywhere agrees.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` moves the checks from COMMIT to here, as an
 * ordinary statement inside the callback, where a failure propagates like any
 * other. Call it as the last thing a financial transaction does.
 */
export async function assertDeferredConstraints(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
}
