# Order lifecycle

Order lifecycle is intentionally split into four dimensions so payment,
production, and delivery facts do not overload one ambiguous status.

## Implemented order state

```text
DRAFT -> PENDING_CONFIRMATION -> CONFIRMED -> IN_FULFILLMENT -> COMPLETED
  |              |                 |              |
  +----------> CANCELLED <--- CANCEL_REQUESTED <--+
                                      ^
DELIVERY_FAILED ----------------------+
       | retry -> IN_FULFILLMENT
```

`COMPLETED` and `CANCELLED` are terminal. Customer cancellation becomes a
request after draft; staff/system authority confirms cancellation. A customer
cannot confirm an order. Bakery authority can start fulfillment only after
confirmation. Each transition requires actor, timestamp, correlation ID, and a
unique idempotency key and is persisted in `OrderStateTransition`.

## Separate dimensions

- Payment: `NOT_STARTED`, `PENDING`, `PAID`, `REFUND_PENDING`, `REFUNDED`.
- Production: `NOT_REQUIRED`, `UNSCHEDULED`, `SCHEDULED`, `IN_PRODUCTION`,
  `READY`, `HANDED_OFF`.
- Delivery: `NOT_REQUIRED`, `UNASSIGNED`, `ASSIGNED`, `PICKED_UP`,
  `OUT_FOR_DELIVERY`, `DELIVERED`, `FAILED`.

The Phase 2E application service now persists the initial customer-authorized
`DRAFT -> PENDING_CONFIRMATION` transition, audit record, and outbox event in
the same serializable transaction as Quote acceptance and capacity reservation.
Later lifecycle transitions remain outside this slice.

## Planned

- Post-creation command handlers, cancellation reason policy, and optimistic
  concurrency for later lifecycle transitions.

## Deferred

- Cart persistence, payment execution, refunds, automated retries, customer UI,
  and live dispatch.

## Open decisions

- Cancellation eligibility after production begins and the associated fees.
- Whether partial fulfillment is required for the Babol pilot.
