# Alo Noon architecture index

Alo Noon is a TypeScript modular monolith in a pnpm monorepo. PostgreSQL is the
system of record; public transport contracts, framework-neutral domain rules,
and Prisma persistence have separate package boundaries.

## Runtime surfaces

```text
Next.js web ─────────┐
Expo customer ───────┼── HTTPS/JSON ── Fastify API ── Prisma ── PostgreSQL 16
Expo courier shell ──┘
```

`/health` tests process liveness without external dependencies. `/ready` owns
required dependency readiness and must return a non-ready response before the
service receives traffic when a required dependency is unavailable.

## Package boundaries

- `packages/contracts` owns versioned Zod transport contracts and OpenAPI.
- `packages/domain` owns executable invariants and imports neither frameworks
  nor Prisma Client.
- `packages/database` owns Prisma schema, migrations, database services, and
  PostgreSQL integration tests.
- applications compose these packages; packages do not depend on applications.
- Prisma models are never public transport contracts.

## Architecture references

| Area                             | Document                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Domain ownership                 | [DOMAIN_BOUNDARIES.md](./DOMAIN_BOUNDARIES.md)                                         |
| Persistent data ownership        | [DATA_OWNERSHIP.md](./DATA_OWNERSHIP.md)                                               |
| Domain model                     | [DOMAIN_MODEL.md](./DOMAIN_MODEL.md)                                                   |
| Domain events, audit, and outbox | [DOMAIN_EVENT_MODEL.md](./DOMAIN_EVENT_MODEL.md)                                       |
| Service boundaries               | [SERVICE_BOUNDARIES.md](./SERVICE_BOUNDARIES.md)                                       |
| Tenant ownership matrix          | [TENANT-DATA-OWNERSHIP-MATRIX.md](./TENANT-DATA-OWNERSHIP-MATRIX.md)                   |
| Multi-tenancy migration plan     | [MULTITENANCY-MIGRATION-AND-PHASE-PLAN.md](./MULTITENANCY-MIGRATION-AND-PHASE-PLAN.md) |
| Multi-tenancy gate index         | [MULTITENANCY-AI-GATE-INDEX.md](./MULTITENANCY-AI-GATE-INDEX.md)                       |
| Accepted product/platform ADRs   | [../decisions/README.md](../decisions/README.md)                                       |
| Tenant and control-plane ADRs    | [adr/](./adr/)                                                                         |

## Delivered slices

- Phase 1 domain, contract, and normalized persistence foundations.
- Phase 2A read-only discovery and serviceability.
- Phase 2B revocable sessions and deny-by-default scoped authorization.
- Phase 2C contract-validating customer discovery/session integration.
- Phase 2D server-owned Cart and immutable Quote snapshots.
- Phase 2E authenticated address-to-order acceptance with authoritative delivery
  pricing and atomic capacity reservation.
- Payment aggregate, integer-IRR double-entry Ledger, and governed tenant Chart
  of Accounts.
- Secure payment-provider foundation and initialization-only provider-agnostic
  Payment Execution Orchestrator.
- Provider-neutral authentication delivery, persisted abuse controls, and
  fail-closed recovery
  ([ADR-0011](../decisions/ADR-0011-production-auth-delivery-foundation.md),
  [operations](../security/AUTHENTICATION_DELIVERY.md)).

## Current boundary

The execution orchestrator prepares an attempt transactionally, invokes only a
registered compatible adapter outside PostgreSQL, and persists a normalized
initialization result in a second transaction. The production composition does
not register a real adapter or secret resolver, so real payment execution fails
closed. Callback processing, inquiry, capture, settlement, reconciliation, and
refunds remain deferred. Authentication delivery likewise has no approved real
SMS adapter, so production SMS remains unavailable by design.

Bakery onboarding/production operations, courier dispatch/tracking, notification
delivery, CRM/admin interfaces, and external commerce integrations remain
foundation-only or planned. Target documents describing those areas are not
runtime evidence.

## Evolution rules

- Preserve the modular monolith until measured scaling needs justify extraction.
- Derive tenant identity from verified server context and set `app.tenant_id`
  transaction-locally for tenant-owned database work.
- Use integer IRR and immutable economic snapshots; never infer legacy economic
  values.
- Keep order, payment, production, fulfillment, and delivery state independent.
- Commit audit and outbox records atomically with protected state changes.
- Use idempotency and bounded `SERIALIZABLE` retries at multi-record command
  boundaries; never classify generic uniqueness conflicts as serialization.
- Add dependencies to `/ready` before serving traffic that requires them.
- Prefer additive forward migrations and forward corrective rollback.
