# Product requirements

This document is the source of truth for Alo Noon product language, and for what
the platform does today as against what it does not. Detailed models live in the
linked product documents; persistence details live in
[`DOMAIN_MODEL.md`](../architecture/DOMAIN_MODEL.md).

The lists below are meant to be checkable. A line under **Working** names
behaviour somebody can exercise against a running deployment; if it cannot be,
the line is wrong and belongs one section down.

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

## The money model

One decision governs the whole commercial surface and every part of the system
bends to it: **money arrives before an order is confirmed, and there are exactly
two ways for it to arrive.**

- **Online gateway** — a bank takes it from a card now.
- **Wallet balance** — a bank took it from a card earlier and the platform has
  been holding it since.

There is no third route. Nothing is settled at the door, no courier carries
cash, and an order is never confirmed against a promise to pay. Delivery fee and
order cost are both computed and collected before the bakery is committed.

A balance that will not cover an order is answered with what is missing, so the
customer tops up and comes back. One order is never split across two sources:
the second way for a half-paid order to exist buys nothing a customer asked for.

Money leaves along three paths and no others: a **refund** to the customer's
wallet, a **withdrawal** from that wallet to the customer's own bank card, and a
**payout** to a bakery or courier partner. All three are double-entry postings
against the tenant's chart of accounts.

## Working

Everything here is implemented, covered by tests against PostgreSQL, and
reachable from at least one of the four applications.

**Foundation.** Framework-independent product classification and order
transition policy. Versioned Zod transport contracts for every surface below.
Multi-tenancy by forced row-level security, with a composite `(id, tenantId)`
foreign key on every tenant-owned relation and a guard test that reads every
migration to prove none was missed.

**Identity and access.** Provider-neutral OTP delivery, persisted abuse
controls, revocable server-side sessions. A staff role catalogue that the
provisioning CLI and the admin routes read from one list, so a granted role is
always one a route accepts. Roles carry a scope: platform staff hold theirs
tenant-wide, a bakery partner's staff hold theirs against one branch.

**Discovery and ordering.** Active-city, serviceability and catalog APIs.
Customer-bound server carts with single-fulfillment-context enforcement,
optimistic versioning, exact server repricing, and immutable expiring quote
snapshots. Order placement, and the full lifecycle from acceptance through
production, hand-off, delivery and completion.

**Payments and the ledger.** A provider-neutral payment pipeline with adapters
for five Iranian gateways, callback receipts, a recovery sweep for stranded
payments, and a per-tenant chart of accounts. Every movement of money is a
balanced double-entry posting, enforced by a database trigger rather than by
application code.

**The wallet.** Top-up through the gateway, payment from balance, transfer to
another customer's balance behind an SMS confirmation, refunds credited on
cancellation, and withdrawal to the customer's own bank card. The statement is
append-only.

**Partner settlement.** A delivered order is divided at the moment of delivery
between the bakery, the courier partner and the platform, from rates copied onto
the earning so a later rate change cannot recompute an old order. Payout runs
claim what is owed and post the discharge; the bank transfer itself is made by a
person and recorded against it.

**Fulfillment and delivery.** Dispatch, courier assignment, trip planning with
road distances where a routing engine is configured, delivery windows, and the
courier's own mobile application.

**Operations.** An admin panel for orders, dispatch, catalogue, pricing,
promotions, financial reporting, partner settlement, customer withdrawals,
provider governance, message templates and staff access. A bakery-facing panel
for a partner's own counter, confined to its own branches. Operator alerts by
email.

**Customer surfaces.** A Persian-first storefront, a customer mobile
application, and the published legal surface — terms, privacy notice, refund
policy and business identity.

## Planned

- Babol zone configuration through the operations tools.
- Scheduled delivery and subscriptions.
- Loyalty.
- Multi-city operations beyond the pilot.
- Electric-motorcycle operations and an inclusive women courier employment
  program. Workforce programs must never become discriminatory dispatch logic.

## Deferred

- External CRM and analytics integrations. The event outbox and consent model
  are implemented; nothing consumes them off-platform yet.
- Independent service extraction. The system is a modular monolith and the
  boundaries are enforced by module structure rather than by network calls.
- White-label branding per tenant. The tenant boundary itself is implemented and
  enforced; only the theming is not.

## Not built, and required before a public launch

These are not deferred product scope. They are the remaining distance between
this repository and a service the public can use, and none of them is a code
change.

- Production provider credentials: an SMS key, a gateway merchant account, and a
  routing engine key. Every adapter exists and is exercised against stubs; none
  has ever been pointed at a live provider.
- A staging environment and a rehearsal of the whole flow against provider
  sandboxes.
- A server, a domain, TLS, backups and monitoring.
- The business identity and the eNamad trust seal. The legal pages read both
  from the environment and say plainly that they are unset until they are;
  nothing is invented on their behalf.

## Open decisions

- Exact Babol pilot polygons and serviceability SLA.
- Legal product labels, allergen vocabulary, and shelf-life approval workflow.
- Cancellation fees and post-production cancellation authority.
- Which gateway is the production default.
