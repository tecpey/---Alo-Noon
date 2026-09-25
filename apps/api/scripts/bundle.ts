/**
 * Bundles the service into files that plain `node` can run.
 *
 * Why this exists: the shared packages in this repository publish raw
 * TypeScript — their `exports` point at `src/*.ts` — which is pleasant to work
 * in and impossible to `node dist/server.js`. Until now the service started
 * with `node --import tsx`, which meant production ran a TypeScript loader,
 * compiling the dependency graph on every boot and carrying the compiler into
 * the deployment. A restart during a morning rush is not the moment to discover
 * that boot takes seconds longer than it needs to.
 *
 * Two things are emitted, because the operator needs both: the server, and the
 * provisioning CLI that the operations guide tells them to run on the very
 * server where no dev dependencies are installed.
 *
 * Type checking is not done here — esbuild strips types without reading them.
 * `pnpm typecheck` is the gate for that, and it covers the same sources.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { build } from 'esbuild'

const manifest = createRequire(import.meta.url)('../package.json') as {
  dependencies: Record<string, string>
}

/**
 * What stays external, stated as an invariant rather than a list.
 *
 * After bundling, `dist/` must need exactly what this package declares as
 * dependencies — nothing more. So the external set *is* the declared
 * dependencies, minus our own workspace packages, which are the whole point of
 * bundling. Anything a workspace package depends on that this one does not
 * (zod, today) gets pulled in, because under pnpm's strict layout it would not
 * be resolvable from `dist/` at runtime otherwise.
 *
 * That failure mode is worth naming: it does not appear at build time, and it
 * does not appear in development where the loader resolves from the workspace
 * root. It appears as the deployed service failing to boot.
 */
const external = Object.keys(manifest.dependencies).filter((name) => !name.startsWith('@alo-noon/'))

// Prisma's client is generated code sitting next to a native query engine, and
// a bundler that swallows it produces a file that cannot find its own engine.
// It is already in `external` via the manifest; the internal alias it loads at
// runtime has to be named separately.
external.push('.prisma/client', '.prisma/client/default')

const result = await build({
  entryPoints: {
    server: 'src/server.ts',
    // The provisioning CLI. Bundled so that `node dist/provision.js` works on a
    // production install, where `tsx` is a dev dependency and absent.
    provision: 'src/provision.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  /**
   * A real `require` for the CommonJS that ends up inside an ESM file.
   *
   * Prisma 7 reaches PostgreSQL through `@prisma/adapter-pg` and `pg`, both
   * CommonJS, and both pulled in through `@alo-noon/database` rather than
   * declared here — so by the rule above they are bundled. CommonJS asks for
   * Node's built-ins with `require('events')`, and an ES module has no
   * `require`: esbuild's stand-in throws `Dynamic require of "events" is not
   * supported` the moment the database module loads. Which is at boot, for
   * both the server and the provisioning CLI.
   *
   * It shipped that way for two weeks because nothing ran the bundle: tests
   * and the CI drives run the TypeScript sources through tsx, where `require`
   * exists. The smoke check below is what now runs it.
   */
  banner: {
    js: "import { createRequire as __aloNoonCreateRequire } from 'node:module';\nconst require = __aloNoonCreateRequire(import.meta.url);",
  },
  // A syntax floor, not the runtime: the service runs on the Node in
  // `.node-version`, which is newer. Anything from 22 up runs this output.
  target: 'node22',
  sourcemap: true,
  // Names survive into stack traces, and an incident is not the time to be
  // reading minified frames. Nobody downloads this file, so its size is free.
  minify: false,
  logLevel: 'warning',
  external,
  metafile: true,
})

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.map')) continue
  process.stdout.write(`${file} — ${(output.bytes / 1024).toFixed(0)} KiB\n`)
}

/**
 * Run what was just built, under plain `node`.
 *
 * Nothing else does: tests and the CI drives run the sources through tsx. That
 * is how a bundle that threw `Dynamic require of "events"` on its first line
 * shipped for two weeks with every gate green — and the first place it would
 * have been noticed was `systemctl start` on launch day.
 *
 * The provisioning CLI is the one that can be run here. With no command it
 * prints its usage and exits 0, touching no database and needing no
 * environment, but only after loading every module the server loads for
 * persistence — the Prisma client, the pg adapter, the domain. A module that
 * cannot load under plain `node` fails here, at build time, instead.
 */
const smoke = spawnSync(process.execPath, ['dist/provision.js'], {
  encoding: 'utf8',
  env: { PATH: process.env['PATH'] ?? '' },
  timeout: 30_000,
})
if (smoke.status !== 0 || !smoke.stdout.startsWith('Usage: provision')) {
  process.stderr.write(
    `The bundle does not run under plain node:\n${smoke.stderr || smoke.stdout || String(smoke.error)}\n`,
  )
  process.exit(1)
}
process.stdout.write('dist/provision.js — loads under plain node\n')
