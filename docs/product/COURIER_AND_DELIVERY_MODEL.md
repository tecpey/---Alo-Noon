# Courier and delivery model

CourierPartner represents an internal or third-party operating organization.
Courier is an operator profile; Vehicle is partner-owned and includes
`ELECTRIC_MOTORCYCLE`. DeliveryTask expresses work, while DeliveryAssignment
records each offer/accept/reject/cancel/complete attempt. A failed task may be
reassigned without rewriting earlier assignments.

Proof references point to controlled object storage; binaries and customer PII
must not be copied into events or logs.

## Implemented

- Partner, courier availability, vehicle type/status, delivery task and
  assignment lifecycle, attempt/failure fields, pickup/delivery deadlines, and
  incident references.

## Planned

- Dispatch policy, provider adapters, courier app commands, proof capture, SLA
  monitoring, and electric-motorcycle operational readiness.
- A women courier employment program may be represented by HR/operations in a
  future bounded context. Gender is intentionally absent from dispatch entities
  and must not affect assignment eligibility.

## Deferred

- Live tracking, route optimization, background location, provider webhooks,
  courier payments, and employment/HR records.

## Open decisions

- Courier partner model for the Babol pilot and proof-of-delivery requirements.
