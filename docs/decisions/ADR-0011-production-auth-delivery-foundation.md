# ADR-0011: Production authentication delivery foundation

- Status: Accepted
- Date: 2026-08-03
- Scope: OTP request delivery and verification; payment execution is excluded
- Depends on: ADR-0001, ADR-0003 (tenant-aware identity), ADR-0007

## Context

The existing OTP runtime generates a cryptographically random six-digit code,
stores only an HMAC digest, bounds expiry and verification attempts, and issues
a revocable server-side session. Delivery is nevertheless represented by a
single `send` callback. Its legacy persistence is not tenant-owned, request
throttling is not a complete distributed abuse policy, provider timeouts cannot
be distinguished from known rejection, and production deliberately has no SMS
adapter.

No Iranian SMS provider is approved in repository governance. Inventing an API
contract or adding a vendor SDK would therefore create an unverifiable
production path.

## Decision

Authentication delivery is a provider-neutral boundary independent of identity,
session, and payment domains. It uses:

- a versioned `AuthenticationDeliveryProvider` SPI and deterministic registry;
- explicit normalized outcomes: delivered, rejected, transient failure,
  permanent failure, and unknown;
- tenant-scoped provider configuration containing only an opaque credential
  reference and non-secret sender/template metadata;
- a secret resolver invoked immediately before provider execution;
- tenant-owned OTP challenges, delivery attempts, and rolling abuse events with
  forced PostgreSQL RLS;
- a `SERIALIZABLE` preparation transaction, provider invocation outside the
  database transaction, and a `SERIALIZABLE` finalization transaction;
- purpose-separated HMAC digests for OTP values, phone-number abuse dimensions,
  source IPs, idempotency fingerprints, and session tokens, backed by three
  independent production peppers;
- a single active challenge policy, five-minute expiry, sixty-second resend
  cooldown, five verification attempts, and bounded rolling send budgets;
- a persisted provider circuit that opens after repeated normalized failures;
- generic public responses that do not disclose account existence or
  phone-specific throttling decisions;
- atomic audit and outbox writes for persisted authentication-delivery state.

The source IP is `request.ip`. Forwarded headers are ignored unless an explicit,
bounded trusted-proxy hop count is configured. If no reliable IP is available,
the request is denied rather than exempted from abuse controls.

An unknown provider outcome remains recoverable and must not be blindly resent.
The associated challenge may still be verified if the message arrived, while a
new delivery is blocked until the uncertainty expires. This is
at-least-once-safe orchestration; it does not claim exactly-once external
delivery.

## Provider decision

No real provider adapter is included. Production uses an empty registry and a
fail-closed credential resolver until Product/Security approves an Iranian SMS
provider, its official API contract, sender/template rules, data-processing
terms, credentials, and operational limits. Tests inject isolated deterministic
adapters and never perform network calls.

## Security and privacy consequences

- Raw OTPs and credentials never enter database, logs, audit, outbox, metrics,
  errors, fixtures, or public responses.
- Full mobile numbers are required transiently at the execution boundary and in
  the tenant-protected challenge record for delivery/recovery; diagnostics use a
  short HMAC-derived token instead.
- Client-provided tenant, provider, sender, template, credential reference,
  limits, or delivery status are never authoritative.
- Deterministic uniqueness conflicts are not retried. Only PostgreSQL
  serialization failures (`40001`, Prisma `P2034`, or `P2010` metadata carrying
  `40001`) receive bounded retries.
- Direct database access remains governed by composite tenant constraints, state
  checks, and forced RLS.
- Pepper rotation is state invalidation, not a transparent configuration change:
  OTP and session rotations revoke their active state, while abuse-key rotation
  must preserve the longest active counter window or use a reviewed dual-key
  rollout.

## Rollout and rollback

The migration is additive. Legacy pending OTP challenges are invalidated without
deleting or economically backfilling data; runtime switches to the new
tenant-owned tables. Deployment is safe before provider approval because no
configuration or adapter is provisioned automatically and requests fail closed.

Application rollback may return to the former fail-closed runtime. Database
rollback is a forward corrective migration; the new security history is not
destructively dropped.

## Deferred

- approved Iranian SMS adapter and sandbox certification;
- provider delivery receipts and callbacks;
- edge/WAF rate limiting in addition to database-authoritative controls;
- administrative provider-governance UI;
- session rotation, passkeys, and privileged step-up authentication.
