# Phase 2D server cart and quote

## Status

- **Implemented:** customer-bound server cart, item mutation/removal, optimistic
  cart versioning, immutable quote snapshots, idempotent quote creation,
  expiration, supersession after cart mutation, API contracts, OpenAPI, Prisma
  migration, audit/outbox records, and customer-app integration.
- **Implemented in Phase 2E:** authenticated address persistence, server-derived
  service-area provenance, authoritative delivery pricing, and atomic quote
  acceptance with a durable bakery-capacity reservation.
- **Planned:** promotion policy and tax policy if applicable.
- **Deferred:** payment, wallet, ledger, refunds, settlement, dispatch, and
  approved production SMS delivery.
- **Open:** final delivery-fee algorithm, quote TTL configuration, exact
  city-timezone capacity calendars, and whether future carts may span multiple
  controlled platform-stock fulfillments.

## Trust boundary

The client sends only an offering identifier, quantity, fulfillment context, and
an optional expected cart version. It never supplies a trusted price, line
total, subtotal, freshness claim, bakery identity, or capacity decision.

The API reloads current offering, product, branch, quality, availability, price,
and capacity facts inside a serializable database transaction. Quotes copy those
facts into immutable integer-money snapshots. Cart mutations supersede every
active quote for that cart.

## Cart boundary

An active cart belongs to exactly one authenticated customer, city, operational
zone, and bakery branch. This deliberately prevents ambiguous production and
delivery orchestration in the MVP. PostgreSQL enforces one active cart per
customer with a partial unique index, bounded quantities, positive versions, and
exact quote arithmetic.

## Quote semantics

A quote:

- records the cart version it priced;
- is created with a unique idempotency key;
- expires ten minutes after creation;
- contains immutable offering, product, classification, price, and total
  snapshots;
- includes an authoritative delivery fee after Phase 2E pricing resolution;
- does not itself create an order, payment, ledger entry, or durable capacity
  reservation; the separate idempotent order command performs acceptance and
  reservation atomically.

## Product-promise boundary

Snapshotting preserves the catalog classification. Only
`SIGNATURE_FRESH + FRESHLY_PRODUCED` may receive freshly-produced language.
Packaged products remain explicitly packaged. Phase 2D does not use or introduce
the promise “hot bread.”

## Brand asset note

The four supplied raster logo references were reviewed during Phase 2D. They are
not committed as canonical production assets because no exact vector,
transparent master, or formally selected primary variant exists yet. The
reference containing “نان داغ، زندگی گرم” is incompatible with the product
promise and must not be used as official copy. Canonical logo production remains
a separate reviewed brand task.
