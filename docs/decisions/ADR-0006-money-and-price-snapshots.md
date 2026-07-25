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
- **Planned:** transactional server-side repricing and snapshot creation.
- **Deferred:** payment-provider settlement, wallet, and ledger implementations.
- **Open:** currencies beyond IRR and the accounting boundary for future
  settlement.
