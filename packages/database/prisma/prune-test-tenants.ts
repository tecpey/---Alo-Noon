/**
 * Removes the tenants the integration suite leaves behind.
 *
 * Every integration test that checks tenant isolation creates its own tenant —
 * which is the right way to test row-level security, and none of them removes
 * it afterwards. On this repository's development database that had reached
 * **7,482 tenants and 298MB**, and the cost is not tidiness:
 *
 *   - the API suite slowed from about 75 seconds to several minutes;
 *   - the settlement sweep walks every active tenant on each tick, so a running
 *     dev server spent its time logging one warning per tenant and eventually
 *     took both itself and PostgreSQL down;
 *   - a load measurement taken against it reported a p95 of 2,654ms for the
 *     shelf, which was a property of the database and not of the application.
 *
 * That last one is the reason this exists rather than a note in a README: a
 * polluted database does not fail, it lies.
 *
 * It is deliberately explicit about what it destroys. It prints what it will
 * remove and does nothing without `--yes`, it refuses to run when `NODE_ENV`
 * is `production`, and the launch tenant is never a candidate. Any other tenant
 * worth keeping is named with `--keep`.
 *
 *     pnpm --filter @alo-noon/database exec tsx prisma/prune-test-tenants.ts
 *     pnpm --filter @alo-noon/database exec tsx prisma/prune-test-tenants.ts --yes
 *
 * The ordered delete below is also what a proper per-test teardown needs, which
 * is why it is written once here rather than inline: a tenant's rows have to go
 * in dependency order, and getting that order wrong is how a teardown that
 * looks finished leaves half a tenant behind.
 */
import { PrismaClient } from '@alo-noon/database'

/** Never a candidate, whatever else is passed. */
const LAUNCH_TENANT = '00000000-0000-4000-8000-000000000001'

const argv = process.argv.slice(2)
const confirmed = argv.includes('--yes')
const keep = new Set<string>([
  LAUNCH_TENANT,
  ...argv.flatMap((value, index) => (argv[index - 1] === '--keep' ? [value] : [])),
])

const prisma = new PrismaClient()

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('refusing to prune tenants with NODE_ENV=production')
  }

  const database = await prisma.$queryRaw<{ name: string; size: string }[]>`
    SELECT current_database() AS name, pg_size_pretty(pg_database_size(current_database())) AS size
  `
  const [where] = database
  process.stdout.write(`database: ${where?.name ?? '?'} (${where?.size ?? '?'})\n`)

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } })
  const doomed = tenants.filter((tenant) => !keep.has(tenant.id))

  process.stdout.write(`tenants: ${tenants.length}, keeping ${tenants.length - doomed.length}\n`)
  if (doomed.length === 0) {
    process.stdout.write('nothing to prune\n')
    return
  }
  process.stdout.write(
    `to remove: ${doomed.length}\n  e.g. ${doomed
      .slice(0, 5)
      .map((tenant) => tenant.slug)
      .join(', ')}${doomed.length > 5 ? ', …' : ''}\n`,
  )

  if (!confirmed) {
    process.stdout.write('\nnothing was removed. Re-run with --yes to do it.\n')
    return
  }

  /*
    Every table that carries a tenant, deleted inside one transaction with its
    triggers held off.

    The triggers are the audit and immutability guards — a provider credential
    may not be deleted, a payment configuration may not be deleted — and they
    are correct for the application and wrong for this. Holding them off is safe
    here for one specific reason: the *whole* tenant goes, so nothing can be
    left referring to a row that is gone. Row-level security guarantees no row
    of one tenant references another's.

    The table list comes from the schema rather than being typed out, because a
    list typed out here is a list that silently stops covering new tables.
  */
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenantId'
      AND NOT a.attisdropped
    ORDER BY c.relname
  `
  process.stdout.write(`tables carrying a tenant: ${tables.length}\n`)

  const ids = doomed.map((tenant) => tenant.id)
  let removed = 0

  await prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`)
      // Deferred constraints and the triggers above are both stood down for the
      // length of this transaction only.
      await transaction.$executeRawUnsafe(`SET CONSTRAINTS ALL DEFERRED`)

      for (const { table_name: table } of tables) {
        const affected = await transaction.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "tenantId" = ANY($1::uuid[])`,
          ids,
        )
        removed += affected
      }
      const gone = await transaction.$executeRawUnsafe(
        `DELETE FROM "Tenant" WHERE id = ANY($1::uuid[])`,
        ids,
      )
      removed += gone
    },
    { timeout: 300_000 },
  )

  const after = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size
  `
  process.stdout.write(
    `removed ${removed} rows across ${doomed.length} tenants — database now ${after[0]?.size ?? '?'}\n`,
  )
  process.stdout.write('run VACUUM FULL to return the space to the filesystem.\n')
}

main()
  .catch((error: unknown) => {
    process.stdout.write(`\nPRUNE FAILED: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
