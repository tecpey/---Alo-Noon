# Alo Noon documentation map

This directory records product intent, architecture, security controls,
operations design, and accepted decisions. Repository behavior and executable
tests are the authority for implementation status; target documents must never
be read as evidence that a capability is shipped.

The repository entry points are the Persian-first [`README.md`](../README.md)
and its factually equivalent English edition [`README.en.md`](../README.en.md).

## Status vocabulary

- **Verified:** implemented on `main` and covered by executable evidence.
- **Foundation:** core invariants or persistence exist, but the end-to-end
  production workflow is incomplete.
- **Deferred:** intentionally outside the current delivery boundary.
- **Planned:** product or architecture intent without shipped runtime behavior.
- **Open:** a decision still requiring product, security, or operations input.

## Recommended reading

### Product, operations, and partners

1. [Product vision](./00-vision/PRODUCT_VISION_FA.md)
2. [Product requirements](./product/PRODUCT_REQUIREMENTS.md)
3. [Catalog and freshness model](./product/CATALOG_AND_FRESHNESS_MODEL.md)
4. [Babol pilot operating model](./02-operations/BABOL_PILOT_OPERATING_MODEL_FA.md)
5. [Bakery partner model](./product/BAKERY_PARTNER_MODEL.md)
6. [Courier and delivery model](./product/COURIER_AND_DELIVERY_MODEL.md)
7. [CRM foundation](./product/CRM_FOUNDATION.md)
8. [MVP roadmap](./07-roadmap/MVP_ROADMAP_FA.md)

### Engineering and security

1. [Architecture index](./architecture/README.md)
2. [Domain boundaries](./architecture/DOMAIN_BOUNDARIES.md)
3. [Data ownership](./architecture/DATA_OWNERSHIP.md)
4. [Service boundaries](./architecture/SERVICE_BOUNDARIES.md)
5. [Domain-event model](./architecture/DOMAIN_EVENT_MODEL.md)
6. [Security baseline](./06-security/SECURITY_BASELINE_FA.md)
7. [Multi-tenancy threat model](./security/MULTITENANCY-AI-THREAT-MODEL.md)
8. [ADR index](./decisions/README.md)

### Assets

- [Brand-asset governance](./assets/brand/README.md)
- [Capability-label catalog](./assets/badges/README.md)
- [Diagram source and export policy](./assets/diagrams/README.md)

## Current verified boundary

The following capabilities are present on `main`:

- tenant-aware identity and authorization foundations with forced PostgreSQL RLS
  on covered tenant data;
- authenticated customer address, serviceability, authoritative delivery
  pricing, immutable Quote snapshots, atomic Quote-to-Order conversion, and
  durable capacity reservation;
- independent Payment and double-entry Ledger foundations with governed tenant
  Chart of Accounts;
- payment-provider configuration, opaque credential references, adapter
  registry/SPI, callback-receipt and replay foundations;
- initialization-only Payment Execution Orchestrator using a recoverable
  two-transaction boundary.

Real provider adapters, callback verification processing, inquiry, capture,
settlement, reconciliation, refunds, production SMS delivery, bakery/courier
operational workflows, notification delivery, CRM UI, and external-store
integrations are not shipped.

## Documentation rules

- Label implemented, foundation, deferred, planned, and open behavior.
- Use the product promise **fresh bread**, never **hot bread**.
- Keep executable invariants in `packages/domain`, transport schemas in
  `packages/contracts`, and persistence in `packages/database`.
- Record material architecture changes as ADRs and include an Architectural
  Impact Assessment in the corresponding PR.
- Do not include credentials, private contact details, real customer data, or
  payment secrets.
- Treat migrations as forward-only, additive production artifacts.
- Update links and status descriptions in the same PR as the verified behavior.
