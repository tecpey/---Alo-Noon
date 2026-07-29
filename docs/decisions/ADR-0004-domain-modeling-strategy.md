# ADR-0004: Focused domain package and normalized persistence

- Status: Accepted
- Date: 2026-07-25

## Decision

Keep executable invariants in a framework-independent `@alo-noon/domain`
package. Keep transport validation in versioned `@alo-noon/contracts` schemas
and persistence in Prisma. Normalize important searchable fields and use JSON
only for bounded geometry/event/audit metadata.

## Consequence

Applications cannot import Prisma models as API contracts. Domain code has no
Fastify, Next.js, Expo, React, or Prisma dependency. We avoid repository/event
bus abstractions until Phase 2 application services need them.

## Status

- **Implemented:** focused domain, contract, and persistence packages.
- **Planned:** application services and repositories that use these packages.
- **Deferred:** generic repository, event-bus, and microservice abstractions.
- **Open:** whether white-label demand eventually justifies multi-tenancy.
