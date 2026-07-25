# Phase 1 product requirements

This document is the source of truth for Alo Noon product language. Detailed
models live in the linked product documents; persistence details live in
[`DOMAIN_MODEL.md`](../architecture/DOMAIN_MODEL.md).

## Product truth

Alo Noon / الو نون is an API-first bread-commerce, bakery-partner, fulfillment,
delivery, CRM, and city-operations platform. Babol, Mazandaran is the initial
market. City, operational zone, bakery, and courier partner IDs are therefore
configuration, never hardcoded business rules.

The customer promise is **fresh bread**, never **hot bread**. Only a
bakery-specific premium signature product with controlled production, pickup,
freshness, and delivery windows may claim `FRESHLY_PRODUCED`. Ordinary
traditional bread is represented as an Alo Noon packaged product when sold.

Initial catalog families are signature fresh, packaged traditional, packaged
fantasy, packaged dietary, and future limited edition products. Persian and RTL
are first-class user experience requirements.

## Implemented in Phase 1

- Framework-independent product classification and order transition policy.
- Versioned runtime contracts for catalog, branch, address, serviceability,
  order drafts, order summaries, money, events, errors, and pagination.
- PostgreSQL models for core geography, partners, catalog, orders, fulfillment,
  delivery, customer events, outbox, audit, support, and incidents.
- CRM timeline/event persistence foundations with consent and PII-minimization
  rules.

## Planned

- Babol zone configuration through operations tools.
- Read-only catalog and serviceability APIs after an OpenAPI contract is
  reviewed.
- Scheduled delivery, subscriptions, loyalty, promotions, dispatch, partner
  settlement, and multi-city operations.
- Electric-motorcycle operations and an inclusive women courier employment
  program. Workforce programs must never become discriminatory dispatch logic.

## Deferred

- Production authentication and authorization.
- Ordering UI and transactional ordering endpoints.
- Payment provider, wallet, ledger, refunds, or settlement execution.
- External CRM, notification, analytics, maps, or courier integrations.
- Multi-tenancy and white-label data partitioning until a real tenant boundary
  is approved.

## Open decisions

- Exact Babol pilot polygons and serviceability SLA.
- Legal product labels, allergen vocabulary, and shelf-life approval workflow.
- Cancellation fees and post-production cancellation authority.
- Payment and settlement provider selection.
