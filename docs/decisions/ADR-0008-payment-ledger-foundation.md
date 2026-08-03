# ADR-0008: Payment aggregate and double-entry ledger foundation

- Status: Accepted
- Date: 2026-08-03

## Decision

Model payment separately from order, production, and delivery state. A payment
starts from the authoritative persisted order total and advances only through
the internal `CREATED -> PENDING -> AUTHORIZED -> CAPTURED` state machine, with
`FAILED` terminal from non-terminal states. Customers cannot supply or mutate a
payment state.

Every captured payment posts one immutable financial transaction with at least
two positive integer-IRR ledger entries. PostgreSQL deferred constraints require
distinct accounts and equal debit and credit totals matching the payment and
order amount. Balances are derived from entries and are never stored directly.

Payment initialization, transitions, order payment-state updates, transition
history, journal entries, audit records, and outbox events share a tenant-scoped
serializable transaction and operation-scoped idempotency key. Forced RLS uses
transaction-local `app.tenant_id` for every financial relation.

## Implemented

- Payment, payment-transition, ledger-account, financial-transaction, and
  ledger-entry persistence.
- Domain state-machine and balanced-posting validation.
- Append-only history and PostgreSQL deferred integrity constraints.
- Tenant/customer/operation-scoped idempotency, audit, and event contracts.
- Internal application service; no public payment-status write endpoint.
- A versioned, deterministic system chart for every tenant, including
  non-postable hierarchy headers and operational posting accounts.
- Automatic and replay-safe tenant financial bootstrap at the PostgreSQL tenant
  boundary, with governed activation, immutable system identity, audit, and
  outbox events.

## Deferred

- Payment gateways, provider callbacks, credential handling, and reconciliation.
- Refunds, settlement jobs, payout calculations, and wallet products.
- Admin and customer payment interfaces.

## Open

- Provider selection and provider-reference storage boundary.
- Reconciliation, settlement, and refund authorization policies.
