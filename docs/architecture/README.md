# Platform foundation architecture

## System context

Alo Noon begins as a modular monorepo with four independently deployable
surfaces. The web and customer mobile applications serve ordering customers; the
courier application serves delivery operators; the Fastify API owns business
orchestration and persistence.

```text
Next.js web ─────────┐
Expo customer ───────┼── HTTPS/JSON ── Fastify API ── Prisma ── PostgreSQL
Expo courier ────────┘
```

## Boundaries

- Applications may depend on packages; packages never depend on applications.
- `contracts` contains transport shapes without framework or database types.
- `database` owns Prisma and exports the generated client and model types.
- `config` validates runtime input at process boundaries.
- `design-tokens` is the visual source of truth across web and mobile.
- The API is composed in `app.ts` so tests can inject dependencies without
  binding a network port.

## Operational model

`/health` proves that the API process can answer requests. `/ready` proves that
required dependencies are available and returns HTTP 503 otherwise. Containers
should use health for liveness and readiness for traffic admission.

PostgreSQL is the system of record. Phase 1 uses bigint integer minor units and
currency for money, UUID persistence IDs, immutable order/address/product/price
snapshots, explicit order transition history, and separate domain outbox, audit,
and engagement records.

`packages/domain` owns framework-independent money, catalog/freshness, order
transition, and event-envelope rules. `packages/contracts/src/v1` owns runtime
Zod transport schemas. Neither exposes Prisma models.

## Evolution rules

- Prefer a modular monolith until scaling evidence justifies service extraction.
- Add idempotency, authentication, audit history, and outbox-backed events
  before introducing transactional ordering endpoints.
- Treat migrations as forward-only production artifacts and test them in CI.
- Add observability exporters through validated configuration, without coupling
  business logic to a vendor SDK.

## Status

- **Implemented:** Phase 0 application surfaces, Phase 1 domain/contract/persistence
  foundations, and the Phase 2A read-only catalog and serviceability application slice.
- **Planned:** authenticated customer context, cart/quote application services, and
  scoped administrative catalog management.
- **Deferred:** transactional orders, payments, authentication, dispatch, CRM
  UI, and external providers.
- **Open:** Babol service polygons, cancellation policy, PostGIS, and settlement
  provider decisions.
