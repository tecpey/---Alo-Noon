# Domain boundaries index

This is the routing index; it does not duplicate detailed rules. The status
column says what exists in this repository today, and it is meant to be
checkable against the code rather than against a plan.

| Boundary            | Authoritative document                                                                                   | Status                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Product truth       | [`PRODUCT_REQUIREMENTS.md`](../product/PRODUCT_REQUIREMENTS.md)                                          | vocabulary and flows implemented                              |
| Catalog/freshness   | [`CATALOG_AND_FRESHNESS_MODEL.md`](../product/CATALOG_AND_FRESHNESS_MODEL.md)                            | rules, schema, contracts and staff management implemented     |
| Customer/household  | [`CUSTOMER_AND_HOUSEHOLD_MODEL.md`](../product/CUSTOMER_AND_HOUSEHOLD_MODEL.md)                          | schema and contracts implemented                              |
| Bakery partner      | [`BAKERY_PARTNER_MODEL.md`](../product/BAKERY_PARTNER_MODEL.md)                                          | schema, contracts and the partner's own branch panel          |
| Ordering            | [`ORDER_LIFECYCLE.md`](../product/ORDER_LIFECYCLE.md)                                                    | policy, schema and the full staff and partner handlers        |
| Courier/delivery    | [`COURIER_AND_DELIVERY_MODEL.md`](../product/COURIER_AND_DELIVERY_MODEL.md)                              | dispatch, assignment, trip planning and the courier app       |
| CRM/events          | [`CRM_FOUNDATION.md`](../product/CRM_FOUNDATION.md) and [`DOMAIN_EVENT_MODEL.md`](DOMAIN_EVENT_MODEL.md) | foundations and outbox implemented; external consumers absent |
| Payments/settlement | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | gateway pipeline, double-entry ledger, wallet, payouts        |
| Promotions/loyalty  | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | promotions implemented; loyalty not started                   |
| Notifications       | [`SERVICE_BOUNDARIES.md`](SERVICE_BOUNDARIES.md)                                                         | outbox, templates, SMS, email and push implemented            |

Identity accounts, tenant-owned OTP challenges, provider-neutral delivery,
persisted abuse controls, revocable sessions, roles, permissions and scope
grants are implemented, along with the staff surfaces that manage them. A role
now declares how far it reaches: platform roles are granted tenant-wide, and the
two bakery-partner roles are granted against a single branch.

Multi-tenancy is implemented and enforced, not deferred. Every tenant-owned
table has forced row-level security and a composite `(id, tenantId)` foreign key
on each of its relations, and a guard test reads every migration to prove none
was left out. What remains deferred under this heading is white-label theming,
which is presentation rather than isolation.

## Status

- **Implemented:** every boundary above, at the level its row states.
- **Planned:** scheduled delivery, subscriptions, loyalty, and multi-city
  operations.
- **Deferred:** external CRM and analytics consumers, per-tenant theming, and
  extraction of any module into an independent service.
- **Open:** extraction thresholds, and which gateway becomes the production
  default.

Provider credentials are not a boundary and are not on this list. Every adapter
here has been exercised against stubs and none against a live provider; see the
last section of [`PRODUCT_REQUIREMENTS.md`](../product/PRODUCT_REQUIREMENTS.md).
