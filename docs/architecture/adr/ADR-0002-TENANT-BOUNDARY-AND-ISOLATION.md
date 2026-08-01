# ADR-0002: Tenant boundary and isolation

- Status: Accepted
- Accepted: 2026-08-01
- Gate: Issue #12
- Decision owners: Architecture, Security, Product, Operations
- Supersedes: the Phase 1 decision to remain multi-city without tenant
  identifiers

## Context

Alo Noon must preserve the controlled Babol MVP while becoming a defensible
multi-tenant platform. A city, operational zone, bakery, branch, courier
partner, household, or customer is not automatically a tenant.

## Decision

A tenant is an independently governed Alo Noon operator boundary: the first
tenant is the internal Alo Noon operating company; later tenants may be approved
franchise or white-label operators. A bakery or courier partner remains a
tenant-owned or tenant-associated domain entity unless a separate commercial
agreement promotes it to an operator tenant.

Every tenant-owned row receives a non-null `tenantId`. Platform reference data
is explicitly classified as global. No record may be implicitly global. Existing
Babol data is backfilled into a seeded internal tenant with stable slug
`alo-noon-internal`; runtime code must never depend on that slug or on Babol.

Tenant context is derived from authenticated membership plus server-controlled
host/application context. Client-supplied tenant IDs are selectors only and
never authority.

## Isolation

- Application repositories require an explicit `TenantContext`; tenant-less
  access is limited to named platform repositories.
- PostgreSQL composite unique constraints and indexes begin with `tenantId`.
- PostgreSQL RLS is required as defense in depth after repository scoping is
  proven; the database session receives the verified tenant ID inside each
  transaction.
- Cache keys, object paths, idempotency keys, queues, events, logs, traces,
  analytics, exports and backups include a non-PII tenant partition.
- Background jobs and outbox consumers reject missing, unknown, suspended or
  mismatched tenant context.
- Cross-tenant support uses time-limited grants with reason, ticket, approver,
  scope and immutable audit; emergency access is separately monitored.

## Lifecycle

Tenant states are `PROVISIONING`, `ACTIVE`, `SUSPENDED`, `OFFBOARDING`, and
`DELETED`. Branding, locale, currency, domains, entitlements, quotas, feature
flags and billing configuration are versioned tenant configuration. Suspension
blocks business writes but preserves controlled export and incident access.

## Consequences

Phase 2E cannot merge until tenancy foundations, backfill, contracts and
isolation tests exist. Modular Monolith remains the deployment architecture;
tenant isolation does not justify premature service extraction.
