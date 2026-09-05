import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { assertDeferredConstraints } from './modules/deferred-constraints'

/**
 * The client defect that `assertDeferredConstraints` exists for.
 *
 * This is pinned as a test rather than left as a comment because the workaround
 * looks like a redundant statement — the kind of line somebody removes while
 * tidying, on the reasonable belief that COMMIT already checks what COMMIT
 * checks. The first test below is what would then be true again, and it is not
 * a bug the next person would find by reading code: everything reports success.
 *
 * If the first test starts failing, the client has been fixed and every
 * `assertDeferredConstraints` call can go.
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

  it('reports success when a deferred trigger refuses the commit', async () => {
    await setUp()
    try {
      let resolved = false
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`INSERT INTO "zz_deferred_probe" VALUES (1)`)
        resolved = true
      })

      // The transaction resolved. The row is not there. Both of those are true
      // at once, which is the whole problem: the database did the right thing
      // and the caller was told the opposite.
      expect(resolved).toBe(true)
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
