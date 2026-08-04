# Architecture decision record index

Accepted ADRs are authoritative within their stated scope. Implementation status
inside an older ADR may become stale; executable code, migrations, tests, and
the repository status matrix determine current delivery status.

## Product and platform decisions

| ADR                                                                                                    | Status   | Purpose                                                                    |
| ------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------- |
| [ADR-0001](./ADR-0001-modular-monolith.md) — Modular Monolith for MVP                                  | Accepted | Preserve domain boundaries without premature service extraction.           |
| [ADR-0002](./ADR-0002-product-freshness-separation.md) — Fresh Signature and Packaged Product Promises | Accepted | Separate bakery-specific fresh production from packaged-stock claims.      |
| [ADR-0003](./ADR-0003-multi-city-partner-abstraction.md) — Multi-city and Partner Abstraction          | Accepted | Keep Babol configurable and providers/cities replaceable.                  |
| [ADR-0004](./ADR-0004-domain-modeling-strategy.md) — Domain Modeling Strategy                          | Accepted | Separate framework-neutral invariants, contracts, and persistence.         |
| [ADR-0005](./ADR-0005-order-state-model.md) — Order State Model                                        | Accepted | Keep order, payment, production, and delivery state independent.           |
| [ADR-0006](./ADR-0006-money-and-price-snapshots.md) — Money and Price Snapshots                        | Accepted | Use integer money and immutable economic snapshots.                        |
| [ADR-0007](./ADR-0007-domain-events-audit-and-outbox.md) — Events, Audit, and Outbox                   | Accepted | Separate transactional events, protected audit, and engagement facts.      |
| [ADR-0008](./ADR-0008-payment-ledger-foundation.md) — Payment and Ledger Foundation                    | Accepted | Govern Payment state and balanced double-entry accounting.                 |
| [ADR-0009](./ADR-0009-payment-provider-foundation.md) — Payment Provider Foundation                    | Accepted | Isolate provider configuration, credentials, attempts, and adapter SPI.    |
| [ADR-0010](./ADR-0010-payment-execution-orchestrator.md) — Payment Execution Orchestrator              | Accepted | Orchestrate initialization using a recoverable provider-agnostic boundary. |
| [ADR-0011](./ADR-0011-production-auth-delivery-foundation.md) — Production Authentication Delivery     | Accepted | Govern tenant-safe OTP delivery, abuse controls, and provider isolation.   |

## Tenant and control-plane decisions

These ADRs use a separate historical namespace under `architecture/adr/`; their
numbers intentionally overlap the product/platform series above.

| ADR                                                                                                                       | Status   | Purpose                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| [ADR-0002](../architecture/adr/ADR-0002-TENANT-BOUNDARY-AND-ISOLATION.md) — Tenant Boundary and Isolation                 | Accepted | Define operator tenants, RLS authority, and tenant-owned data.       |
| [ADR-0003](../architecture/adr/ADR-0003-TENANT-AWARE-IDENTITY-AUTHORIZATION.md) — Tenant-aware Identity and Authorization | Accepted | Separate global identity from contextual tenant authorization.       |
| [ADR-0004](../architecture/adr/ADR-0004-AI-CONTROL-PLANE-TRUST-MODEL.md) — Governed AI Control-plane Trust Model          | Accepted | Keep advisory agents policy-bound, tenant-aware, and human-governed. |

## Adding an ADR

Use the established Markdown format, record status and date, explain context,
decision, consequences, security/tenant implications, rollout, and rollback.
Link the ADR from this index and include an Architectural Impact Assessment in
the implementation PR.
