# Multi-tenancy migration, rollback and phase plan

## Goal

Introduce tenant isolation without breaking the controlled Babol MVP or
fabricating production readiness.

## Phase G1 — decisions and contracts

Approve ADR-0002 through ADR-0004, ownership matrix and threat model. Add
`tenantId` to event envelopes, job payloads and request context. Tenant identity
is never accepted as authorization.

## Phase G2 — additive schema

Create `Tenant`, domains, memberships and tenant-scoped grants. Add nullable
`tenantId` columns and supporting indexes to existing business tables. Seed the
internal Alo Noon tenant with an immutable ID. No behavior switches yet.

## Phase G3 — backfill and verification

Backfill all existing Babol records transactionally by aggregate dependency.
Record counts and orphan checks before and after. Reject ambiguous ownership
rather than guessing. Add composite tenant foreign keys and uniqueness
constraints.

## Phase G4 — application enforcement

Require `TenantContext` in HTTP repositories, transactions, cache, files, events
and worker jobs. Add negative cross-tenant integration tests. Make new writes
require non-null tenant ownership.

## Phase G5 — database defense

Enable and test PostgreSQL RLS for tenant-owned tables. Make `tenantId`
non-null. Remove transitional fallbacks. Validate backup/export/restore and
support-access controls.

## Phase G6 — reconcile Phase 2E

Only now implement address persistence, delivery pricing, durable reservation
and Quote-to-Order. Conversion requires customer, cart, quote, address, branch,
price policy and idempotency key to share the same tenant.

## Rollback

Before enforcement, rollback is a forward migration that disables new
tenant-aware code while retaining additive columns and records. After
tenant-owned writes exist, columns or tenant records must never be dropped as
rollback. Restore the previous application version, preserve tenant data, and
apply a reviewed corrective forward migration. RLS activation uses a feature
gate and transaction-level monitoring; emergency disablement requires incident
approval and audit.

## Minimum tests

- same ID under another tenant returns indistinguishable not-found/denied
  response;
- forged tenant header and body are ignored for authority;
- cross-tenant joins, quote conversion and idempotency replay fail;
- stale and suspended membership/job fail;
- cache, event and object keys cannot omit tenant scope;
- support grant expiry immediately removes access;
- RLS blocks direct unscoped SQL in the application role;
- AI retrieval cannot combine tenant evidence or invoke privileged tools without
  approval.

## Exit criteria

Issue #12 may close only when ADRs are accepted, migration and rollback are
rehearsed in CI, negative tests pass, Babol operates as the internal tenant
without hardcoded assumptions, and Phase 2E dependencies are updated.
