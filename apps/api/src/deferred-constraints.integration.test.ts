import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { assertDeferredConstraints } from './modules/deferred-constraints'

/**
 * What the client does when COMMIT is refused.
 *
 * This file used to assert the opposite. Under Prisma 5.22 an interactive
 * `$transaction` whose COMMIT was refused by a deferred trigger resolved as
 * though it had succeeded: the database rolled back correctly and the caller
 * was told the reverse, which for money is the worst failure mode there is.
 * `assertDeferredConstraints` was written for that, and the test said so —
 * "if the first test starts failing, the client has been fixed".
 *
 * It started failing on Prisma 7. Ten runs of a deferred trigger that refuses
 * at COMMIT: ten refusals reported to the caller, none swallowed, no rows
 * written. So the first test now pins the *fixed* behaviour rather than the
 * defect — a test that asserts a bug which no longer exists is worse than no
 * test, because the day it starts passing again nobody will know why.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

afterAll(async () => prisma.$disconnect())

databaseDescribe('deferred constraints over PostgreSQL', () => {
  const setUp = async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "zz_deferred_probe" (id INT)`)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION zz_deferred_probe_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'probe refused'; END $$`)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_trg ON "zz_deferred_probe"`)
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER zz_trg AFTER INSERT ON "zz_deferred_probe"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION zz_deferred_probe_guard()`)
  }
  const tearDown = async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "zz_deferred_probe"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_deferred_probe_guard()`)
  }

  it('reports the refusal to the caller, rather than resolving as a success', async () => {
    await setUp()
    try {
      // The behaviour this whole file was written because the client lacked.
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(`INSERT INTO "zz_deferred_probe" VALUES (1)`)
        }),
      ).rejects.toThrow(/probe refused/)

      // And the database agrees: nothing was written. Both halves matter — a
      // caller told the truth about a rollback that did not happen would be a
      // different bug with the same shape.
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM "zz_deferred_probe"`,
      )
      expect(rows[0]?.count).toBe(0n)
    } finally {
      await tearDown()
    }
  })

  it('raises where the caller can see it once the checks are forced', async () => {
    await setUp()
    try {
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(`INSERT INTO "zz_deferred_probe" VALUES (1)`)
          await assertDeferredConstraints(transaction)
        }),
      ).rejects.toThrow(/probe refused/)
    } finally {
      await tearDown()
    }
  })
})
