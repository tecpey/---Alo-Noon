# ADR-0006: Integer money and immutable price snapshots

- Status: Accepted
- Date: 2026-07-25

## Decision

Represent money as non-negative bigint minor units plus currency. Serialize API
amounts as decimal strings. Copy current offering prices and product/address/
bakery facts into order snapshots at creation.

## Consequence

Floating-point arithmetic is prohibited. Current catalog/address edits cannot
rewrite order history. Phase 2 command handlers must compare the caller's
expected price with the current offering and create snapshots transactionally.

## Delivery status

- **Implemented:** bigint money value object, contracts, schema snapshots, and
  tests.
- **Implemented:** transactional server-side Cart repricing and immutable,
  expiring Quote snapshot creation with integer-string API amounts.
- **Implemented:** authoritative delivery pricing, immutable address/policy/
  distance snapshots, and atomic capacity-backed Quote-to-Order conversion.
- **Implemented:** integer-IRR Payment aggregate and immutable double-entry
  ledger foundation; balances are derived rather than stored.
- **Planned:** promotion and discount policy snapshots.
- **Deferred:** payment gateways, refunds, settlement, and wallet products.
- **Open:** currencies beyond IRR and the accounting boundary for future
  settlement.
