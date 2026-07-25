# Data ownership

PostgreSQL is the system of record for durable platform facts. Clients may cache
display data but never own customer, household, address, catalog availability,
order, support, fulfillment, courier, or operational history.

| Data                     | Owner                        | Historical rule                               |
| ------------------------ | ---------------------------- | --------------------------------------------- |
| Customer/consent/address | Customer boundary            | orders retain delivery snapshots              |
| Product/classification   | Catalog boundary             | items retain SKU/name/class/claim snapshots   |
| Offering/current price   | Bakery partner boundary      | items retain integer price snapshots          |
| Order and transitions    | Ordering boundary            | append transitions; terminal states immutable |
| Fulfillment/delivery     | Fulfillment boundary         | assignment attempts and proofs are retained   |
| Engagement timeline      | CRM boundary                 | minimize PII and enforce consent basis        |
| Audit                    | Operations/security boundary | append-only and correlation-addressable       |

## Status

- **Implemented:** ownership-preserving schema and contracts.
- **Planned:** repositories enforcing aggregate transactions and retention jobs.
- **Deferred:** external systems of engagement and data warehouse replication.
- **Open:** deletion/anonymization policy under applicable Iranian regulations.
