# Customer and household model

Customer is the platform profile identified initially by an E.164 mobile number.
Authentication credentials are not modeled in Phase 1. Household groups payers,
adults, dependents, and recipients without requiring every recipient to hold a
login.

Addresses belong to customers and reference city and optional operational zone.
Coordinates, recipient details, instructions, and verification state are
server-side. Orders copy an immutable delivery snapshot so address edits or
archival do not rewrite history.

Consent timestamps distinguish transactional communication, explicit marketing
consent, and opt-out. `crmProfileRef` is an integration reference, not an
external CRM as source of truth.

## Implemented

- Customer lifecycle, household/member roles, saved addresses, address
  verification, archival, consent fields, and runtime address contracts.

## Planned

- Authorized household spending permissions, customer profile services,
  serviceability evaluation, and support timeline projections.

## Deferred

- Authentication, household wallet, subscriptions, identity verification, and
  external CRM synchronization.

## Open decisions

- Household invitation/consent flow and retention policy for closed customers.
