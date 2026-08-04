# Service boundaries

Phase 1 remains a modular monolith. These are code and data ownership
boundaries, not deployed microservices.

- Identity & Access: provider-neutral OTP delivery, sessions, roles,
  permissions, tenant RLS, abuse controls, and audit; real SMS adapter deferred.
- Customer & Household: profile, consent, member and address lifecycle.
- Geography & Serviceability: cities, zones, service-area evaluation.
- Bakery Partner & Catalog: organizations, branches, capacity, products,
  variants, offerings, quality.
- Ordering: draft validation, snapshots, transitions, idempotency.
- Fulfillment & Delivery: production/handoff plan, tasks, assignments, proofs.
- CRM & Engagement: consent-aware timeline and segmentation inputs.
- Support & Operations: cases, interventions, incidents, audit.
- Payments & Settlement: internal Payment aggregate and double-entry ledger
  foundation; provider execution, refunds, wallet, and settlement remain
  deferred.
- Promotions & Loyalty: future contract boundary, no engine.
- Notifications: future intent/outbox consumer, no provider.

Applications depend on contracts/domain packages. Only the API composition root
may wire persistence and future application services. Domain and contracts do
not import Fastify, Next.js, Expo, React, or Prisma Client.

## Status

- **Implemented:** package boundaries and persistence vocabulary.
- **Planned:** modules inside the API beginning with read-only catalog and
  serviceability.
- **Deferred:** independent deployment and multi-tenant/white-label isolation.
- **Open:** module extraction thresholds based on measured scale/team ownership.
