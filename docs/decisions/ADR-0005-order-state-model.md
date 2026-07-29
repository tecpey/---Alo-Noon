# ADR-0005: Separate order, payment, production, and delivery states

- Status: Accepted
- Date: 2026-07-25

## Decision

Use a small customer/business order lifecycle and separate payment, production,
and delivery dimensions. Persist every order-state transition with authority,
timestamp, correlation, reason, and idempotency key.

## Consequence

This prevents one giant status from encoding contradictory facts. Application
services must coordinate cross-dimension invariants. `COMPLETED` and `CANCELLED`
are terminal. Phase 2 must define post-production cancellation fees before
enabling transactional commands.

## Delivery status

- **Implemented:** state dimensions, transition policy, persistence history, and
  tests.
- **Planned:** transaction-bound command handlers and concurrency control.
- **Deferred:** payment execution, automated refunds, and live dispatch.
- **Open:** post-production cancellation eligibility, fees, and partial
  fulfillment.
