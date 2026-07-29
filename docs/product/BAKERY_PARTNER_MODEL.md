# Bakery partner model

Bakery is the legal/commercial organization. BakeryBranch is the operational
location linked to one city and operational zone. A branch owns operating hours,
daily capacity, pickup instructions, operational suspension, and quality state.

BakeryProductOffering links a branch to a ProductVariant and supplies price,
availability, preparation estimate, and capacity. This avoids making a product
itself bakery-specific while supporting signature variants offered only by their
approved branch.

## Implemented

- Partner and branch lifecycle, quality status, suspension fields, branch hours,
  date capacity slots, offering price/capacity/availability, and branch summary
  contract.

## Planned

- Partner-user permissions, onboarding workflow, quality inspections, capacity
  reservation, agreement versions, and operational branch tools.

## Deferred

- Partner settlement execution, bakery UI, automated production printing, and
  supplier integrations.

## Open decisions

- Agreement and quality-document storage, capacity granularity below one day,
  and platform stock ownership.
