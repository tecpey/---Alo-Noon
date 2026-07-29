# Claude instructions

Follow [AGENTS.md](AGENTS.md) as the canonical repository policy.

Before implementing a change, inspect the affected workspace and its package
scripts. Reuse shared contracts, configuration, design tokens, and database
types. Do not introduce application-to-application imports. Validate all five
root quality commands before reporting completion.

For domain work, read `docs/product/PRODUCT_REQUIREMENTS.md` and
`docs/architecture/DOMAIN_BOUNDARIES.md`. Preserve the separation among domain
rules, versioned Zod transport contracts, Prisma persistence, domain outbox
events, audit events, and consent-aware engagement events.
