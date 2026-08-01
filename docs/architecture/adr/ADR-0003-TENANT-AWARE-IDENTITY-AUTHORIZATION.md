# ADR-0003: Tenant-aware identity and authorization

- Status: Proposed
- Gate: Issue #12
- Depends on: ADR-0002

## Decision

Identity is global; authorization is contextual. An account may belong to multiple tenants through explicit `TenantMembership` records. Platform roles and tenant roles are separate namespaces and cannot imply each other.

An authenticated request resolves:

1. global account and revocable session;
2. server-verified tenant context;
3. active membership or narrowly approved platform support grant;
4. permission and existing domain scope (city, zone, branch, courier partner or self);
5. step-up requirement for sensitive actions.

The effective decision is deny by default and is recorded for sensitive operations. URLs, headers and request bodies never grant tenant authority.

## Proposed core records

- `Tenant`
- `TenantDomain`
- `TenantMembership`
- `TenantRole`, `TenantPermission`, `TenantGrant`
- `PlatformRole`, `PlatformPermission`, `PlatformGrant`
- `SupportAccessGrant`
- `AuthorizationDecisionAudit`

Sessions store no permanent authorization snapshot. Membership and grant changes take effect without waiting for session expiry. Workers receive signed or persisted job context and re-authorize before side effects.

## Required controls

- membership uniqueness is tenant-aware;
- tenant switching requires a fresh server resolution and CSRF protection;
- platform support cannot silently enumerate tenant data;
- step-up is required for finance, exports, permissions, secrets, tenant configuration and impersonation;
- support access has scope, reason, ticket, approver, expiry and revocation;
- suspended tenant or membership blocks writes immediately;
- negative tests cover IDOR, guessed IDs, forged headers, stale jobs, cache confusion and cross-tenant joins.
