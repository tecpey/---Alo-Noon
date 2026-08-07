# ADR-0012: Gateway settlement and payment capture

- Status: Accepted
- Date: 2026-08-07
- Supersedes the deferral in ADR-0010 ("a verified or accepted provider result
  does not capture Payment, post a ledger entry, or mark an Order paid")

## Context

ADR-0010 delivered initialization only. A customer could be sent to a gateway
and their return could be recorded, but nothing established whether they had
actually paid. `Payment` never left `CREATED`, no journal was ever posted, and
`Order.paymentState` never reached `PAID`. The business could take a customer to
a payment page and had no way to know the money arrived.

The three integrated Iranian gateways (IDPay, NextPay, Shepa) do not sign their
callbacks. The customer's return redirect is an ordinary browser navigation
whose every parameter is attacker-controllable. Each gateway instead exposes a
server-to-server verify call, keyed by the reference it issued at
initialization, which both confirms the transaction and finalizes it on the
gateway's side.

## Decision

Add a settlement phase between callback intake and capture.

**The adapter SPI is extended, not replaced.** `ProviderVerificationInput` gains
`providerReference`, `expectedAmount`, `paymentAttemptId`, and `timeoutMs`;
`ProviderVerificationResult` gains `settledAmount` and `alreadySettled`. One
method now serves both gateway families: signature-verifying gateways decide
from the callback body, and Iranian gateways call home. `CALLBACK_VERIFICATION`
remains the capability, because for these gateways the verify call _is_ how a
callback is verified.

**The decision to move money is a pure domain function.** `evaluateSettlement`
takes the expected amount, the reference we recorded, and the gateway's answer,
and returns `SETTLE`, `REJECT`, `RETRY`, or `QUARANTINE`. It reads no clock, no
configuration, and no I/O. It is fail-closed in both directions:

- A confirmation reporting no amount settles nothing. A confirmation that merely
  repeats the question proves nothing.
- A confirmation for any amount other than the exact expected one settles
  nothing. Under-payment is the classic attack — confirming a hundred-Rial
  transaction against a million-Rial order — and over-payment is a
  reconciliation problem. Both are `QUARANTINE`: never captured, never silently
  dropped.
- A confirmation carrying a different transaction reference settles nothing.
- `alreadySettled` still settles. Iranian gateways answer a repeated verify with
  "already verified", and that reply is exactly what makes retry safe.

**Capture posts into clearing accounts, not revenue.** Debit
`A_1100_CASH_CLEARING`, credit `L_2100_PAYMENT_CLEARING`. At capture the money
is with the gateway and the bread is not delivered; recognising revenue here
would overstate it for every order later cancelled or refunded.

**Ordering survives a crash.** Capture runs before the bookkeeping that records
it. A crash between them leaves a captured payment whose attempt is not yet
`VERIFIED`; the next run sees the payment already captured, reports settled, and
finishes. The reverse order could mark a payment settled that no journal backs.

**Writes go through the services that own their aggregates.** The attempt's
transitions and the receipt's verdict each carry audit and outbox records that
deferred database constraints check at commit. `settleAttempt` and
`concludeCallback` on the provider service write those pairings; the
orchestrator does not write attempt or receipt rows itself.

**Two triggers, one guarantee.** The customer's return settles inline because it
is the fastest trigger available. A one-minute sweep over unprocessed receipts
is the guarantee: an unreachable gateway, a closed tab, or a dead process is
recovered there. Both paths are idempotent and converge on the same verdict.

## Consequences

- A payment can now reach `CAPTURED`, and an order `PAID`, without human action.
- `QUARANTINE` is a state that requires a human. It is deliberately not
  auto-resolved: an amount mismatch is either an attack or a bug, and both need
  looking at. Operators find them as rejected receipts with a reason on the
  audit trail.
- Settlement is at-least-once against the gateway. Adapters must tolerate a
  repeated verify, which all three do by reporting the transaction as already
  settled.
- Refunds, cancellation, and payout to bakeries remain unbuilt. The clearing
  liability accumulated at capture is what those will later draw down.
- NextPay bills in Toman. A Rial amount that is not a multiple of ten cannot be
  expressed to it, and settlement refuses rather than rounding.
