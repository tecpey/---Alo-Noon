# QA and audit pass — Shahrivar 1405

What was driven, what it found, and what was measured after each fix. Every
figure here comes from a running system; nothing is estimated from source.

## How it was run

| Surface                | Driven by                           | Against                            |
| ---------------------- | ----------------------------------- | ---------------------------------- |
| The money path         | `apps/api/scripts/qa-drive.ts`      | A TLS sandbox gateway on loopback  |
| Authorization          | `apps/api/scripts/authz-probe.ts`   | The running API, two real accounts |
| The customer interface | Playwright, phone viewport, `fa-IR` | **`next build && next start`**     |

> **The app does not hydrate under `next dev` in this container.** The dev
> server's hot-reload WebSocket cannot complete its handshake through the agent
> proxy, so nothing is interactive and every click silently does nothing. A UI
> audit run against it reports the whole shop as broken. Audit the build.

## Findings

### 1. A paid customer returned to a 404 — the callback route did not exist

`PAYMENT_CALLBACK_BASE_URL` and `PAYMENT_RESULT_REDIRECT_URL` were independent.
The first is the address adapters hand the gateway; the second is what makes the
route at that address exist. Set only the first, and every gateway goes live,
the customer pays, and comes back to nothing: no receipt recorded, nothing for
the sweep to settle, an order left `PENDING_CONFIRMATION` with the card debited.

Found by the first end-to-end drive that reached a real gateway redirect. Fixed:
no adapter is registered unless both are set, and a half-configured deployment
says so in the log. Guarded by `apps/api/src/payment-callback-wiring.test.ts`,
which reads the composition root — `buildApp` was covered from every angle, and
`server.ts` decides whether the dependency is ever passed.

### 2. Every rate-limited request answered 500, not 429

`@fastify/rate-limit` does not send what `errorResponseBuilder` returns — it
throws it, and the error handler takes the status from the thrown value. The
builder returned the response envelope, which carries no `statusCode`, so every
rate-limited request in the API answered `500 INTERNAL_ERROR` and logged at
error level as "Unhandled error".

The damage is in what a client does next: a 500 says the shop is broken, and the
reasonable answer to that is to retry — the opposite of backing off, so the
limiter added load instead of shedding it. Genuine faults were buried in a log
full of "Unhandled error" lines that were nothing of the kind.

Measured after: the same route answers `429 RATE_LIMIT_EXCEEDED`, and the log
has no "Unhandled error" lines left.

### 3. A closed sheet was closed to the eye and open to the keyboard

Tabbing the home page landed on «بستن», «بابل» and «دیدن نان‌ها» — inside the
basket drawer and the city sheet, both closed and parked off the right edge.
`aria-hidden` removes a subtree from the accessibility tree and leaves its
controls focusable, which ARIA forbids: the screen reader is told the region is
not there while focus is inside it, so it says nothing and the person hears
silence.

`inert` now does both halves. Measured after: **117 tab stops on the home page,
none inside a closed sheet**, and the drawer still opens, takes focus, and
closes on Escape with focus returned.

### 4. Targets that were tall but not wide

The shared floor set `min-block-size` and nothing on the inline axis, so the
basket's quantity buttons rendered **30px wide and 44px tall** and the product
page's 42px — while the readiness note claimed nothing was under 44px. Fixed at
the three controls; a test now reads the declared width of anything that looks
like a control.

### 5. Smaller, and fixed

- The header search box removed its own outline and replaced it with a colour
  shift. No visible focus indicator under WCAG 2.4.7; it now draws a ring.
- No `touch-action: manipulation` anywhere, so every tap waited out the
  browser's double-tap window before the click fired.
- `ArchTexture` hard-coded its SVG pattern id and the home page draws it twice,
  so the second rectangle was painted from the first's pattern.

## What passed

**The money path, end to end, over a real gateway round trip:**

```
sign-up → empty wallet → shelf → fare → address → cart → quote → order →
open payment → redirect → pay → return → callback → CAPTURED →
order PAID → replayed callback charges nothing twice →
abandoned NOK captures nothing → forged authority moves nothing →
operator accepts → dispatch → offer → courier accepts → picked up → delivered
```

The capture is asserted against **the order's** amount, not the gateway's
figure.

**Authorization — thirty checks, none crossed.** One ordinary customer cannot
read another's order or address, cannot reach the operator panel, the bakery
queue or the courier list, cannot grant themselves a role or register a gateway
credential, cannot transfer money they do not have, cannot transfer zero or a
negative amount, cannot credit their own wallet, and cannot withdraw from an
empty one. A refused transfer sends no SMS.

**The interface, on a 390px phone in Persian:** zero findings across thirteen
routes — no unnamed control, no sideways scroll, no target under 24px, no
duplicate id, no invisible focus stop, no console error, heading order intact,
`dir="rtl"` throughout.

## What a false positive cost, and what it taught

Four of the audit's own detectors were wrong before they were right, and each
one nearly became a "fix" to working code:

| The detector said                          | It was actually                                           |
| ------------------------------------------ | --------------------------------------------------------- |
| The search box has no focus ring           | The ring is on the bar, via `:focus-within` — an ancestor |
| Five category chips have no focus ring     | The ring is on the tile each chip draws — a descendant    |
| The card's sheen overflows the viewport    | It is parked outside a parent with `overflow: hidden`     |
| Every login page's mobile field is unnamed | It is named by a wrapping `<label>`, not `label[for]`     |

The same happened on the API side: three of the authorization probe's early
checks passed because they sent a field the schema does not accept (`amountRial`
for `amount`, `score` for `breadScore`) or called a route that does not exist. A
probe that guesses a contract tests the parser and reports it as the rule
holding.

**Measuring the rendered system is only worth something if the measurement is
checked too.**

## Still not covered

- No real user has walked any of this. Every audit is measurement against a
  criterion; NN/g's five users would find more.
- No load test. Irrelevant at tens of orders a day, not at hundreds.
- Courier app offline behaviour: an action taken with no signal is not queued.
- Backup restore is not rehearsed.
