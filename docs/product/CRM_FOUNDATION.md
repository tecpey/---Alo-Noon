# CRM foundation

The platform database is the durable source of customer, household, address,
order, support, and engagement facts. `CustomerEvent` supports a consent-aware
customer timeline; transactional domain events and staff audit records remain
separate as described in
[`DOMAIN_EVENT_MODEL.md`](../architecture/DOMAIN_EVENT_MODEL.md).

## Implemented

- Versioned event names/envelopes, consent basis, correlation/causation IDs,
  customer timeline persistence, support cases/notes, operational incidents, and
  PII-minimization validation.

## Planned

- Timeline projection service, segmentation attributes derived from durable
  facts, support workflows, and consent-aware notification intents.

## Deferred

- CRM UI, campaigns, external analytics/CRM providers, telephony, loyalty, and
  automated segmentation.

## Open decisions

- Event retention, deletion/anonymization rules, approved segmentation
  vocabulary, and lawful basis per communication channel.
