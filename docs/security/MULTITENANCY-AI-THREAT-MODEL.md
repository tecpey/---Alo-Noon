# Multi-tenancy and AI control-plane threat model

## Protected assets

Customer PII, addresses, credentials, orders, pricing, bakery operations, courier location, financial records, tenant configuration, audit history, observability evidence, AI memory, source code and deployment authority.

## Trust boundaries

HTTP client to API; API to database/cache/object store; outbox to workers; observability pipeline to AI retrieval; AI model to tool broker; sandbox to GitHub; human approval to privileged execution.

| Threat | Example | Mandatory mitigation | Verification |
|---|---|---|---|
| Cross-tenant IDOR | guessed order or quote ID | repository scope + RLS + opaque IDs | negative integration tests |
| Forged tenant context | header/body tenant ID | server-derived context | forged-header tests |
| Cache/queue confusion | key or job lacks tenant | typed tenant-prefixed keys/envelopes | contract tests |
| Unsafe support access | silent tenant impersonation | approved expiring grant + audit | access-expiry tests |
| Backup/export leakage | mixed tenant export | partitioned export manifest + encryption | restore drill |
| Prompt injection | malicious log or ticket directs tools | untrusted-data boundary + tool policy | adversarial evals |
| Sensitive-data disclosure | PII sent to model | classification, redaction, minimization | canary/DLP tests |
| Excessive AI authority | model deploys or refunds | deterministic broker + human approval | denied-action tests |
| Poisoned memory | raw conversation becomes truth | curated provenance workflow | memory admission tests |
| Supply-chain patch abuse | generated patch adds backdoor | isolated build, SAST, tests, review | PR gate |
| Cost/loop exhaustion | agents recurse or retry | budgets, depth/time limits, circuit breaker | chaos tests |
| Model/vendor outage | control plane blocks operations | AI is non-critical advisory path | dependency-failure tests |

## Security acceptance gate

No Phase 2E merge until the first six isolation threats have automated negative coverage and AI privileged actions fail closed without approval.
