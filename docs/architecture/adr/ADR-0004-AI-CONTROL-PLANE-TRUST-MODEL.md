# ADR-0004: Governed AI control-plane trust model

- Status: Proposed
- Gate: Issue #12

## Decision

Alo Noon AI C-level agents are advisory control-plane services, not autonomous executives. Initial roles are CEO, CTO, CPO, COO, CISO, CFO/Finance, CX/CRM and Data/AI. Each agent has a versioned charter, approved evidence scopes, measurable responsibilities, model configuration, tool allow-list, budget, evaluation set and rollback version.

Agents may detect, correlate, explain, prioritize, draft incidents, propose patches and open draft work items. They may not write to production, deploy, access raw secrets, change permissions, perform financial actions, contact customers, or cross tenant boundaries without deterministic policy evaluation and explicit human approval.

## Evidence and memory

Approved inputs include redacted logs, traces, metrics, incidents, deployments, product events, decisions and postmortems. Customer PII and tenant-confidential business data are separated from general observability. Durable AI memory contains only curated facts, approved decisions and evaluated outcomes with provenance, retention and deletion metadata. Raw model conversations are not authoritative memory.

## Tool execution path

1. retrieve evidence under tenant and purpose scope;
2. redact and classify;
3. evaluate prompt-injection and data-exfiltration risk;
4. produce a traceable hypothesis with confidence and citations;
5. validate proposed code in an isolated ephemeral environment;
6. run deterministic tests and security policy;
7. open a draft PR or incident proposal;
8. require human review for merge, deployment or privileged action.

All requests, retrieved evidence references, tool calls, approvals, outputs, cost, latency and model versions are auditable. Provider abstraction must support model replacement without changing authorization policy.

## Fail closed

Missing tenant context, provenance, approval, policy result or redaction classification denies the action. An LLM cannot override this decision.
