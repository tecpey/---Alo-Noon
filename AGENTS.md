# Repository instructions

## Scope and boundaries

- Keep deployable applications in `apps/*` and reusable, framework-neutral code
  in `packages/*`.
- API contracts belong in `packages/contracts`; database access belongs in
  `packages/database`. Applications must not duplicate either.
- Executable business invariants belong in `packages/domain`. That package must
  remain independent of application frameworks and Prisma Client.
- Never expose Prisma models as transport contracts. Version runtime contracts
  under `packages/contracts/src/v*` and update OpenAPI before adding a public
  domain endpoint.
- The product promise is “fresh bread,” never “hot bread.” Only validated
  bakery-specific `SIGNATURE_FRESH` variants may claim freshly produced.
- Keep order, payment, production, and delivery states separate; all order-state
  changes require authority, transition history, correlation, and idempotency.
- Preserve Persian-first RTL behavior in user-facing interfaces. Source code,
  identifiers, and technical documentation remain English.
- Keep `/health` independent of external dependencies. Add every required
  dependency to `/ready` before serving traffic.

## Change workflow

1. Read the nearest package manifest and existing tests before editing.
2. Add or update tests with behavior changes.
3. Run `pnpm format`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
   `pnpm build` from the repository root.
4. Never commit environment files, generated build output, or credentials.
5. Prisma schema changes require a reviewed migration and regenerated client.
6. Documents must label implemented, planned, deferred, and open decisions; do
   not present a planned capability as shipped.

Use conventional commits. Keep commits focused and do not bypass CI checks.
