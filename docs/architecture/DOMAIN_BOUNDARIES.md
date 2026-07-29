# Domain boundaries index

This is the routing index; it does not duplicate detailed rules.

| Boundary            | Authoritative document                                                                                   | Phase 1 status                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Product truth       | [`PRODUCT_REQUIREMENTS.md`](../product/PRODUCT_REQUIREMENTS.md)                                          | implemented vocabulary; flows deferred         |
| Catalog/freshness   | [`CATALOG_AND_FRESHNESS_MODEL.md`](../product/CATALOG_AND_FRESHNESS_MODEL.md)                            | rules/schema/contracts implemented             |
| Customer/household  | [`CUSTOMER_AND_HOUSEHOLD_MODEL.md`](../product/CUSTOMER_AND_HOUSEHOLD_MODEL.md)                          | schema/contracts implemented                   |
| Bakery partner      | [`BAKERY_PARTNER_MODEL.md`](../product/BAKERY_PARTNER_MODEL.md)                                          | schema/contracts implemented                   |
| Ordering            | [`ORDER_LIFECYCLE.md`](../product/ORDER_LIFECYCLE.md)                                                    | policy/schema implemented; handlers deferred   |
| Courier/delivery    | [`COURIER_AND_DELIVERY_MODEL.md`](../product/COURIER_AND_DELIVERY_MODEL.md)                              | schema implemented; dispatch deferred          |
| CRM/events          | [`CRM_FOUNDATION.md`](../product/CRM_FOUNDATION.md) and [`DOMAIN_EVENT_MODEL.md`](DOMAIN_EVENT_MODEL.md) | foundations implemented; integrations deferred |
| Payments/settlement | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | documented only                                |
| Promotions/loyalty  | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | documented only                                |
| Notifications       | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | outbox-ready; provider deferred                |

Identity accounts, OTP challenges, revocable sessions, roles, permissions, and
scope grants are implemented in Phase 2B. Provider-specific SMS delivery and
administrative grant-management interfaces remain deferred.

## Status

- **Implemented:** the routed boundaries and Phase 1 foundations shown above.
- **Planned:** further Phase 2 application services within these boundaries.
- **Deferred:** approved SMS delivery and other providers, grant-management UI,
  and independent services.
- **Open:** extraction thresholds and any future multi-tenant isolation model.
