# Phase 0 architecture

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

PostgreSQL is the system of record. Monetary amounts use integer Iranian rials;
timestamps are stored as PostgreSQL timestamps through Prisma. Phase 0 models
customers, bakeries, products, couriers, orders, and immutable order-item
prices.

## Evolution rules

- Prefer a modular monolith until scaling evidence justifies service extraction.
- Add idempotency, authentication, audit history, and outbox-backed events
  before introducing transactional ordering endpoints.
- Treat migrations as forward-only production artifacts and test them in CI.
- Add observability exporters through validated configuration, without coupling
  business logic to a vendor SDK.
