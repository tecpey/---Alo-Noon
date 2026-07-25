# Alo Noon

Persian-first platform foundation for fresh-bread ordering, bakery fulfillment,
and courier delivery.

Phase 1 establishes domain language, catalog/freshness rules, order state
policy, versioned contracts, and a normalized PostgreSQL model. It does **not**
provide a finished commerce flow, real payments, or production authentication.

## Workspace

| Project                  | Purpose                              | Local command              |
| ------------------------ | ------------------------------------ | -------------------------- |
| `apps/web`               | Next.js customer web experience      | `pnpm dev:web`             |
| `apps/api`               | Fastify HTTP API                     | `pnpm dev:api`             |
| `apps/customer-mobile`   | Expo customer application            | `pnpm dev:customer-mobile` |
| `apps/courier-mobile`    | Expo courier application             | `pnpm dev:courier-mobile`  |
| `packages/database`      | PostgreSQL schema and Prisma client  | `pnpm db:studio`           |
| `packages/domain`        | Framework-independent business rules | —                          |
| `packages/contracts`     | Framework-neutral API contracts      | —                          |
| `packages/config`        | Validated runtime configuration      | —                          |
| `packages/design-tokens` | Shared Persian-first design tokens   | —                          |

## Prerequisites

- Node.js 26.3 or newer
- pnpm 11.17 or newer
- PostgreSQL 16 (or Docker)

## Local setup

```bash
cp .env.example .env
cp packages/database/.env.example packages/database/.env
docker compose up -d postgres
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

The API listens on `http://localhost:3001`. Its operational endpoints are:

- `GET /health` — process liveness; does not depend on external services.
- `GET /ready` — traffic readiness; returns HTTP 503 while PostgreSQL is
  unavailable.

## Product and architecture references

The [documentation map](docs/README.md) preserves the product vision, Babol
pilot model, CRM and logistics blueprints, security baseline, roadmap, and
architecture decisions. These documents describe the intended product and target
architecture; [the Phase 0 architecture](docs/architecture/README.md) describes
what the current foundation implements.

Repository policy is documented in [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

Start Phase 1 reading with
[product requirements](docs/product/PRODUCT_REQUIREMENTS.md) and the
[domain-boundary index](docs/architecture/DOMAIN_BOUNDARIES.md). The
[repository documentation map](docs/README.md) distinguishes current
implementation from plans and retained Persian product context.

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

These are the same gates enforced by GitHub Actions. See
[the architecture overview](docs/architecture/README.md) for boundaries and
deployment assumptions.
