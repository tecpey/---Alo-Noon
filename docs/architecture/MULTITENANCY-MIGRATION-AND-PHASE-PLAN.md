# Multi-tenancy migration, rollback and phase plan

## Goal

Introduce tenant isolation without breaking the controlled Babol MVP or
fabricating production readiness.

## Phase G1 — decisions and contracts

Approve ADR-0002 through ADR-0004, ownership matrix and threat model. Add
`tenantId` to event envelopes, job payloads and request context. Tenant identity
is never accepted as authorization.

## Phase G2 — additive schema ✅ implemented

Create `Tenant`, domains, memberships and tenant-scoped grants. Add nullable
`tenantId` columns and supporting indexes to existing business tables. Seed the
internal Alo Noon tenant with an immutable ID. No behavior switches yet.

## Phase G3 — backfill and verification

### G3A — data backfill ✅ implemented

Backfill all existing pre-tenancy Babol records transactionally. Record counts
before and after, abort on missing authority or any conflicting tenant
ownership, and prove that no tenant-less row remains. This step is data-only and
preserves nullable columns so runtime behavior does not switch prematurely.

### G3B — relational tenant integrity ✅ implemented

Add reviewed composite tenant parent/child foreign keys and tenant-aware
uniqueness constraints by aggregate dependency. Reject cross-tenant joins at the
database boundary without enabling RLS or making columns non-null yet.

## Phase G4 — application enforcement ✅ implemented

Require `TenantContext` in HTTP repositories, transactions, cache, files, events
and worker jobs. Add negative cross-tenant integration tests. Make new writes
require non-null tenant ownership.

## Phase G5 — database defense (under review in PR #18)

Make all 32 implemented business-table `tenantId` columns and
`AuthSession.activeTenantId` non-null. Enable and force deny-by-default
PostgreSQL RLS with transaction-local `app.tenant_id` policies. Auth, Commerce
and development Seed operations set that context only inside their database
transaction so pooled connections cannot leak tenant authority.

The CI isolation proof uses a temporary non-owner, non-superuser,
non-`BYPASSRLS` role. It verifies that missing context returns no business rows,
the selected tenant cannot read another tenant, and cross-tenant writes fail at
the PostgreSQL boundary. Tenant bootstrap tables remain outside business-row RLS
because Host-to-Tenant resolution must occur before authentication.

Backup/export/restore procedures and audited support-access controls remain
separate operational exit criteria before Issue #12 may close.

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
