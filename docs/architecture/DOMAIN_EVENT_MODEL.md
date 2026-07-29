# Domain event model

## Three distinct records

| Kind             | Purpose                                                     | Persistence                                                  |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Domain event     | A committed business fact used for reliable downstream work | `DomainEventOutbox` in the same transaction as state changes |
| Audit event      | Who did what to a protected entity and when                 | append-only `AuditEvent`                                     |
| Engagement event | Consent-aware customer timeline/behavior fact               | `CustomerEvent`                                              |

All events use an event ID, name, version, occurred-at timestamp, actor,
subject, correlation ID, optional causation ID, and consent basis. Payloads
reference server-side entities and reject obvious direct PII keys. JSON payloads
are versioned event-specific data, not substitutes for normalized state.

Defined event names are `customer.created`, `customer.address_added`,
`customer.preference_updated`, `product.viewed`, `product.added_to_cart`,
`order.created`, `order.confirmed`, `order.cancelled`, `order.delivered`, and
`support.case_created`.

## Status

- **Implemented:** framework-independent envelope validation, transport schema,
  outbox/audit/customer-event tables and indexes.
- **Planned:** transaction-bound event writer, publisher lease/retry policy,
  timeline projection, and notification-intent consumer.
- **Deferred:** broker, analytics vendor, CRM vendor, notification provider.
- **Open:** retention periods, payload registry tooling, and publisher ordering
  guarantee per aggregate.
