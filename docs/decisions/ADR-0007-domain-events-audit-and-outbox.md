# ADR-0007: Separate domain events, audit, and engagement

- Status: Accepted
- Date: 2026-07-25

## Decision

Persist transactional domain events in an outbox, protected-entity actions in an
append-only audit table, and consent-aware customer timeline facts in a separate
customer-event table. Share correlation and versioning conventions, not one
vague event table.

## Consequence

Each record has a clear retention and access purpose. Payloads minimize PII.
External brokers, analytics, CRM, and notification providers remain deferred;
Phase 2 must publish only after atomic state/outbox persistence is implemented.

## Delivery status

- **Implemented:** separate schemas, event envelope validation, indexes, and
  tests.
- **Planned:** atomic event writer, publisher leasing, retry policy, and
  projections.
- **Deferred:** brokers and external CRM, analytics, and notification providers.
- **Open:** retention periods, aggregate ordering guarantees, and payload
  registry tooling.
