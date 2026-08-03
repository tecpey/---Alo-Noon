# ADR-0009: Payment provider and secure credential-reference foundation

- Status: Accepted
- Date: 2026-08-03

## Decision

Payment providers are isolated behind a capability-explicit, versioned adapter
SPI. An immutable registry rejects duplicate identities, unsupported SPI
versions, and test-only adapters in production. Provider configurations pin the
adapter implementation and SPI versions so multiple adapter generations can
coexist during controlled migrations without changing historical attempts.
Provider-specific statuses are translated into normalized outcomes and never
become authoritative payment or ledger state directly. Production execution
fails closed when no production adapter is registered.

Provider configuration, credential references, payment attempts, transition
history, and callback receipts are tenant-owned. Forced RLS uses
transaction-local `app.tenant_id`, and composite foreign keys prevent
cross-tenant relationships. Configuration governance and attempt changes use
serializable transactions with bounded retry, append-only history, atomic audit,
and transactional outbox records.

Application tables store only opaque references using an approved secret-manager
URI scheme. Credential material is resolved at the adapter execution boundary,
outside database transactions, and is disposed after use. API contracts, audit,
outbox, errors, and callback receipts never include credential material,
authorization headers, signatures, or unreviewed raw payloads.

Callback intake persists a bounded redacted representation plus SHA-256 body and
approved-header fingerprints. Provider-scoped external event IDs and tenant-wide
idempotency keys reject conflicting replay. Signature rejection can update only
the callback receipt; it cannot capture a Payment or post ledger entries.

## Implemented

- Capability-explicit, SPI-versioned adapter registry, signature-verification,
  and secret-resolver interfaces. The registry is proven with 100 isolated
  providers and controlled adapter-version coexistence.
- Tenant provider configuration, opaque credential references, governed
  activation, one-default enforcement, health metadata, payment attempts, and
  append-only history.
- Safe callback receipt, replay protection, signature-verification
  orchestration, redaction, audit, outbox, RLS, composite tenant integrity, and
  integration tests.
- Internal services and versioned contracts only; no provider-facing public
  execution API.

## Deferred

- Real provider adapters, redirects, outbound HTTP, settlement, reconciliation,
  refunds, payouts, and customer or admin payment interfaces.
- Provider-specific credential provisioning and automated health probes.

## Rollout and rollback

Deploy the additive migration before using internal provider services. Existing
payments and journals are untouched. Roll back application usage by disabling
the new service; correct schema defects through a forward migration rather than
a destructive downgrade.
