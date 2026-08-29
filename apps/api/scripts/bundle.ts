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
  // Matches the Node the service is deployed on. Setting it lower would have
  // esbuild down-level syntax the runtime supports natively, for nothing.
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
