# Catalog and freshness model

The executable rules are in `@alo-noon/domain/product`; this document explains
their product meaning.

## Classification dimensions

| Dimension                 | Values                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ProductFulfillmentClass` | `SIGNATURE_FRESH`, `PACKAGED_TRADITIONAL`, `PACKAGED_FANTASY`, `PACKAGED_DIETARY`, `LIMITED_EDITION` |
| `FreshnessClaim`          | `FRESHLY_PRODUCED`, `PACKAGED`, `SHELF_STABLE`, `NONE`                                               |
| `ProductionMode`          | `MADE_TO_ORDER`, `SCHEDULED_BATCH`, `READY_STOCK`, `EXTERNAL_PACKAGED_SUPPLY`                        |
| `FulfillmentControl`      | `CONTROLLED_PICKUP`, `PARTNER_HANDOFF`, `PLATFORM_STOCK`, `THIRD_PARTY_SUPPLY`                       |

`SIGNATURE_FRESH` must claim `FRESHLY_PRODUCED`, use made-to-order or scheduled
batch production, use a controlled pickup or partner handoff, and define
production, pickup, and freshness windows. Packaged families cannot claim
freshly produced and require packaging plus shelf life. `LIMITED_EDITION` cannot
claim freshly produced until a later governance decision defines its controls.

Product is the stable merchandising identity. ProductVariant owns SKU,
classification, ingredient/allergen/dietary metadata, packaging, and freshness
policy. BakeryProductOffering binds a variant to a branch, price, capacity, and
availability. Prices are integer minor units with currency.

## Implemented

- Domain validation, database enums/check constraints, runtime read contracts,
  lifecycle states, historical order-item classification and price snapshots.

## Planned

- Controlled vocabularies for ingredients, allergens, dietary attributes, and
  media assets; operations approval for labels and freshness windows.

## Deferred

- Inventory engine, recommendation engine, promotion pricing, subscription
  bundles, and limited-edition release automation.

## Open decisions

- Whether packaged stock is held by a branch or an Alo Noon stock location.
- Governance process for future non-signature fresh exceptions.
