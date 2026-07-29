# Phase 2B identity, session, and access-control slice

## Implemented

- E.164 OTP request and verification contracts in Zod and OpenAPI.
- Cryptographically generated six-digit OTP values delivered only through an
  injected provider. OTP values are HMAC-digested with a deployment secret
  before persistence.
- Five-minute expiry, sixty-second resend cooldown, five requests per rolling
  hour, five verification attempts, single consumption, and generic
  anti-enumeration API responses.
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

- Approved SMS-provider adapter, delivery receipts, and operational monitoring.
- Administrative role/grant management endpoints with dual-control for
  privileged permissions.
- Session rotation, device inventory, step-up authentication, and passkeys.
- Redis-backed edge throttling in addition to the transactional database limits.

## Deferred

- Password authentication, social login, payment authorization, KYC, and
  external identity providers.

## Open decisions

- SMS provider and domestic delivery-compliance requirements.
- Final customer session lifetime and device-management policy.
- Privileged-role approval workflow and emergency-access policy.
