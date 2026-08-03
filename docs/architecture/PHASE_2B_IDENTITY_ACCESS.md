# Phase 2B identity, session, and access-control slice

## Implemented

- Strict Iranian E.164 OTP request and verification contracts in Zod and
  OpenAPI.
- Cryptographically generated six-digit OTP values delivered only through an
  injected provider. OTP values are HMAC-digested with a deployment secret
  before persistence.
- Five-minute expiry, sixty-second resend cooldown, persisted phone/IP/tenant/
  provider budgets, five verification attempts, single consumption, and generic
  anti-enumeration API responses.
- Versioned provider-neutral delivery SPI and deterministic registry, opaque
  credential resolution, normalized outcomes, timeout-as-unknown handling,
  circuit state, recovery without blind resend, and atomic delivery
  audit/outbox.
- Tenant-owned challenges, delivery attempts, abuse events, memberships, and
  sessions protected by forced RLS and transaction-local tenant context.
- Opaque 256-bit session tokens. Only token HMAC digests are stored. Sessions
  are server-side, expiring, inspectable, and revocable.
- HttpOnly, `SameSite=Lax`, production-`Secure` cookie transport. Bearer
  transport is accepted for non-browser API clients, but tokens are never
  returned in a JSON response.
- Identity accounts linked to customer records, normalized roles and
  permissions, and deny-by-default grants scoped to global, city, operational
  zone, bakery branch, courier partner, or self.
- Audit events for challenge creation/delivery failure, identity verification,
  and session creation/revocation. Summaries and metadata exclude phone numbers,
  raw OTP codes, and session tokens.

## Security invariants

- Authentication peppers are independent deployment secrets, required in
  production, and never have committed defaults.
- Expired, consumed, invalidated, over-attempted, revoked, suspended, or
  scope-mismatched credentials are denied.
- The customer session-inspection endpoint requires the active
  `session.self.read` permission at the matching `SELF` scope.
- Authorization receives explicit resource context and never infers cross-city
  or cross-partner access from an identifier alone.

## Planned

- Approved Iranian SMS-provider adapter and external delivery receipts.
- Production metrics exporter and alert integrations for the implemented
  low-cardinality observer port.
- Administrative role/grant management endpoints with dual-control for
  privileged permissions.
- Session rotation, device inventory, step-up authentication, and passkeys.
- Edge/WAF throttling in addition to the transactional database limits.

## Deferred

- Password authentication, social login, payment authorization, KYC, and
  external identity providers.

## Open decisions

- SMS provider and domestic delivery-compliance requirements.
- Final customer session lifetime and device-management policy.
- Privileged-role approval workflow and emergency-access policy.

Operational and security details are maintained in
[`../security/AUTHENTICATION_DELIVERY.md`](../security/AUTHENTICATION_DELIVERY.md).
