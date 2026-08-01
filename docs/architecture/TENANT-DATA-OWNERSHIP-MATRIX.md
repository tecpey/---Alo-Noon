# Tenant data ownership matrix

This matrix classifies current and near-term aggregates. `Tenant-owned` means every persistent row and derived artifact carries `tenantId`. `Global reference` is read-only to tenants and changed only by platform authority.

| Aggregate | Ownership | Parent / partition | Cross-tenant rule |
|---|---|---|---|
| Tenant, domain, plan | Platform-governed | Tenant | Platform admin only |
| Account / credential | Global identity | Account | No business-data access by identity alone |
| Session | Global identity + active tenant context | Account | Re-resolve membership on switch |
| Membership / tenant grants | Tenant-owned | Tenant + account | No implicit platform authority |
| City / zone / service area | Tenant-owned | Tenant | Same geography may exist in many tenants |
| Customer / household / address | Tenant-owned | Tenant | No global customer profile |
| Bakery / branch / capacity | Tenant-owned | Tenant | Partner linkage is explicit |
| Product definition | Tenant-owned by default | Tenant | Global templates must be copied/versioned |
| Offering / price / availability | Tenant-owned | Tenant + branch | Never shared by bare product ID |
| Cart / cart item | Tenant-owned | Tenant + customer | One tenant per cart |
| Quote / quote item | Tenant-owned immutable snapshot | Tenant + cart | Conversion must match tenant |
| Order / transitions / snapshots | Tenant-owned | Tenant + order | No cross-tenant fulfillment |
| Payment / refund / ledger / settlement | Tenant-owned | Tenant + legal entity | Platform roll-up is derived and restricted |
| Courier / vehicle / delivery / route | Tenant-owned | Tenant | Shared providers require explicit association |
| Notification / print job / label | Tenant-owned | Tenant + order | Templates and retries remain partitioned |
| CRM / support / quality | Tenant-owned | Tenant + subject | PII purpose and retention required |
| Outbox / idempotency | Tenant-owned | Tenant + producer | Keys are unique within tenant and operation |
| Audit event | Tenant-owned or platform audit | Explicit scope kind | Immutable; no ambiguous global row |
| Logs / traces / metrics | Tenant-partitioned metadata | Tenant pseudonymous key | PII redacted before AI access |
| AI memory / finding / proposal | Tenant-owned or platform-governance | Explicit evidence scope | No mixed-tenant retrieval |
| Design tokens / public taxonomy | Global reference or tenant override | Version | Overrides cannot mutate global source |

## Invariant

A new table, event or object-store artifact cannot be introduced until its row in this matrix is added and reviewed.

