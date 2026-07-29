# Phase 1 domain model

## Aggregate boundaries

- **Customer/Household:** profile, consent, members, and addresses. Order stores
  snapshots rather than reaching through this aggregate for historical facts.
- **Geography:** City owns OperationalZone; zone owns bounded GeoJSON
  ServiceAreas. Serviceability is a future domain service.
- **Bakery Partner:** Bakery owns branches; branches own hours and capacity.
  Offerings bind branches to catalog variants.
- **Catalog:** Product owns ProductVariant classification and policy. Product
  pricing is never stored on Product; offerings provide current prices.
- **Order:** owns items, four state dimensions, immutable snapshots, and ordered
  transition history. It references but does not own customer/catalog records.
- **Fulfillment/Delivery:** Fulfillment coordinates preparation/handoff;
  DeliveryTask owns assignment attempts.
- **CRM/Support/Operations:** CustomerEvent, SupportCase, and
  OperationalIncident are distinct records linked by stable IDs.

## Modeling tradeoffs

- UUIDs are stable database identifiers; human-facing orders use separate
  `publicId` values.
- Money is bigint minor units plus `Currency`; API JSON uses unsigned integer
  strings to avoid precision loss.
- Address, bakery, SKU, classification, packaging, and price facts are copied to
  orders/items. Mutable source records therefore cannot corrupt history.
- GeoJSON is bounded to service-area geometry because Prisma 5 has no portable
  polygon type. Important searchable geography remains normalized.
- Arrays hold ingredients/allergens/dietary tags until governed vocabularies are
  approved; they are not arbitrary JSON.
- JSON is limited to GeoJSON, event payloads, and bounded audit metadata.
- No `tenantId` exists: multi-city is implemented, multi-tenancy is not adopted.
- Phase 0 placeholder tables are replaced only when empty; the migration aborts
  rather than silently destroying data.

## Status

- **Implemented:** schema, migration, seed references, domain value objects and
  policies, contracts, tests.
- **Planned:** application services and repositories in Phase 2.
- **Deferred:** payment, promotion, notification, identity, and workforce data
  models.
- **Open:** PostGIS adoption and partial/multi-branch orders.
