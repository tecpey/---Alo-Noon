# Contributing

## Working principles

1. Preserve API-first boundaries. Business rules belong in backend services, not
   client-only code.
2. Do not use browser storage as the source of truth for orders, CRM, wallets,
   logistics, or customer history.
3. Every domain change requires tests, documentation, and an explicit migration
   plan.
4. Never hardcode Babol, a bakery, a courier provider, pricing rules, or product
   availability into application logic.
5. Use feature branches and focused pull requests.
6. Commit messages should follow Conventional Commits.

## Required checks

- formatting
- linting
- type checking
- unit and integration tests
- security review for authentication, authorization, payments, wallet, PII,
  telephony, and partner integrations
