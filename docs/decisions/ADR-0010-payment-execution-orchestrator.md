# ADR-0010: Provider-agnostic payment initialization orchestration

- Status: Accepted
- Date: 2026-08-04

## Context

The provider foundation supplies versioned adapters, governed provider
configuration, opaque credential references, payment attempts, forced RLS,
audit, and outbox persistence. It intentionally does not define when an
authenticated checkout may invoke an adapter or how durable state surrounds an
external invocation. Performing that work in the Payment aggregate would couple
financial truth to gateway behavior and would not scale safely across providers.

## Decision

Add an application orchestration boundary for payment initialization only. The
caller supplies a payment identifier and an idempotency key. Tenant, customer,
order, amount, currency, provider configuration, credential reference, adapter
implementation version, and SPI version are derived server-side.

The orchestrator depends on the capability-explicit adapter registry and secret
resolver interfaces. It contains no provider names or provider-specific request
or response types. Provider selection requires exactly one active, default,
healthy configuration for the tenant, environment, checkout context, IRR, and
`PAYMENT_INITIALIZATION` capability. The registry then resolves the exact
provider code, adapter implementation version, SPI version, environment, and
capability. Test adapters and test credential resolvers fail closed in
production.

Initialization uses two PostgreSQL SERIALIZABLE transactions around the adapter
boundary:

1. Transaction A sets transaction-local tenant context, authorizes ownership,
   snapshots the canonical execution fingerprint, creates one attempt, and
   commits `INITIALIZATION_PENDING` history, audit, and outbox records.
2. Credentials are resolved, the adapter is invoked, and credential bytes are
   disposed outside the database transaction. Only bounded normalized output is
   retained.
3. Transaction B locks and reloads the attempt, verifies its fingerprint and
   expected version, then atomically commits the result, append-only history,
   audit, and outbox records.

A crash after Transaction A leaves a recoverable pending attempt. Replay uses
the same attempt, provider request idempotency key, and fingerprint. A crash
after provider invocation but before Transaction B can cause another invocation;
the system therefore promises at-least-once-safe orchestration, not exactly-once
external execution. Provider adapters must honor the stable idempotency
metadata. Client keys are hashed with the authoritative actor identity before
persistence, so customers cannot preempt one another's tenant-local key
namespace. The globally unique attempt ID is the stable provider request
idempotency key.

Normalized initialization outcomes are `ACCEPTED`, `CUSTOMER_ACTION_REQUIRED`,
`REJECTED`, `RETRYABLE_FAILURE`, `PERMANENT_FAILURE`, and fail-closed `UNKNOWN`.
A verified or accepted provider result does not capture Payment, post a ledger
entry, or mark an Order paid.

## Architectural impact

- **Boundaries:** application orchestration is added above the framework-neutral
  Payment and provider domains; Prisma remains confined to the API persistence
  adapter.
- **Dependencies:** orchestration points inward to contracts and domain SPI and
  outward only through injected registry and credential abstractions. No gateway
  package or generic HTTP client is introduced.
- **Multi-tenant and multi-city:** tenant identity remains host/session derived
  and transaction-local RLS scoped. Provider policy is tenant scoped and does
  not branch on city, preserving future tenant and city-specific configuration.
- **Provider scalability:** provider code is data and registry identity, never
  an orchestration conditional. Many providers and coexisting adapter versions
  do not change the Payment domain.
- **White label:** routing, provider choice, merchant identity, and credentials
  remain tenant configuration, with no brand-specific behavior.
- **Security:** raw credentials, provider payloads, authorization headers, and
  provider errors are excluded from persistence, events, logs, and contracts.
- **Data model:** nullable normalized result fields extend PaymentAttempt.
  Legacy incomplete attempts are not backfilled and fail closed on orchestrator
  replay.

## Implemented

- Authenticated customer initialization command and injectable route boundary.
- Deterministic provider selection, versioned registry lookup, execution policy,
  credential resolution, adapter invocation, result validation, and redaction.
- Recoverable attempt lifecycle through `INITIALIZATION_PENDING`, `INITIALIZED`,
  `CUSTOMER_ACTION_REQUIRED`, or `FAILED` only.
- Scoped idempotency, bounded serialization retry, append-only attempt history,
  forced-RLS-safe persistence, atomic audit/outbox records, and integration
  tests.

## Deferred

- Real provider adapters and outbound production HTTP.
- Redirect consumption, callback intake or verification, inquiry execution,
  capture, ledger posting, settlement, reconciliation, refunds, failover,
  circuit breakers, background jobs, and payment UI.

## Rollout and rollback

Deploy the additive nullable migration before enabling an injected orchestrator.
The production server remains unconfigured until an approved production adapter
and credential resolver exist, so execution fails closed. Roll back by disabling
route injection and orchestration calls. Preserve attempt history and use a
forward corrective migration; do not destructively downgrade provider records.
