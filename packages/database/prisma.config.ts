import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Where the Prisma CLI looks, now that it no longer guesses.
 *
 * Version 7 stopped reading the schema path and the datasource URL out of
 * `package.json` and the ambient environment. That is an improvement: this file
 * is the one place that says where the schema and the migrations are, and a
 * command run from the wrong directory now fails instead of quietly operating
 * on nothing. `dotenv/config` is imported explicitly for the same reason — the
 * CLI no longer loads `.env` on its own.
 */

/**
 * Read rather than `env('DATABASE_URL')`, which throws when the variable is
 * absent — at *load* time, for every command.
 *
 * `prisma generate` does not connect to anything; it reads the schema and
 * writes TypeScript. Demanding a database URL for it means a fresh clone cannot
 * generate its client, so it cannot typecheck, so the repository does not build
 * until somebody has a database — which is exactly backwards.
 *
 * The commands that do connect still need it, and still say so: `migrate` with
 * no datasource configured fails with its own message rather than a missing
 * environment variable at import.
 */
const url = process.env['DATABASE_URL']

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(url ? { datasource: { url } } : {}),
})
