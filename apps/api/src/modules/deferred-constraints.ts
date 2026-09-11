import type { Prisma } from '@alo-noon/database'

/**
 * Forces every deferred constraint to be checked before the transaction ends.
 *
 * Several of this schema's guarantees are deferred constraint triggers: the
 * double-entry balance guard cannot run when the transaction row is inserted,
 * because its entries do not exist yet, so it runs at COMMIT. PostgreSQL raises
 * there and rolls the whole transaction back, correctly.
 *
 * This was written because Prisma 5.22 did not report that. An interactive
 * `$transaction` whose COMMIT was refused resolved as though it had succeeded —
 * the database stayed consistent, because nothing was written, and the caller
 * was told the opposite of the truth. For money that is the worst failure mode
 * there is: a settlement run believes it captured a payment, an order is
 * treated as paid, a customer is told their balance went up, and no row
 * anywhere agrees.
 *
 * **Prisma 7 fixed that**, and `deferred-constraints.integration.test.ts` now
 * pins the fixed behaviour. This is kept anyway, for a reason of its own rather
 * than as a workaround: `SET CONSTRAINTS ALL IMMEDIATE` moves the checks from
 * COMMIT to here, so a violation is raised by an ordinary statement inside the
 * callback — in the application's own stack, at the point the offending write
 * happened — instead of arriving from the transaction manager after the
 * callback has returned and the context that caused it is gone. One round trip
 * per financial transaction buys an error somebody can actually locate at three
 * in the morning.
 *
 * Call it as the last thing a financial transaction does.
 */
export async function assertDeferredConstraints(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
}
