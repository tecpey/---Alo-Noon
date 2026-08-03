# Architecture diagram source and export policy

The authoritative diagrams are GitHub-compatible Mermaid blocks embedded in
[`README.md`](../../../README.md) and [`README.en.md`](../../../README.en.md).
They cover:

1. system context;
2. platform/container architecture;
3. address-to-order flow;
4. atomic Quote-to-Order transaction;
5. payment and ledger architecture;
6. provider initialization orchestration;
7. tenant/RLS request path.

Every diagram has adjacent prose, and future components are labelled as future
or deferred. They intentionally omit secrets, internal hostnames, credentials,
and unimplemented infrastructure.

## PNG export status

No Mermaid CLI or other reviewed Mermaid renderer is available in the current
workspace. In accordance with repository policy, this PR does not commit
screenshots or manually redrawn PNG approximations. GitHub-rendered Mermaid
source remains authoritative.

When a deterministic, reviewed renderer is added separately, exports may use
these reserved names:

- `system-context.png`
- `platform-containers.png`
- `checkout-flow.png`
- `atomic-quote-to-order.png`
- `payment-ledger.png`
- `payment-execution-orchestrator.png`
- `tenant-rls-path.png`

Exports must be regenerated from the Mermaid source, checked in both light and
dark themes, and never become the only source of architectural meaning.
