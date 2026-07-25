# ADR-0001: Modular Monolith for MVP

- Status: Accepted
- Date: 2026-07-23

## Decision

Start with a TypeScript modular monolith in a monorepo, backed by PostgreSQL,
with explicit domain boundaries and versioned APIs. Introduce Redis only when a
measured caching, queueing, or coordination requirement justifies operating it.

## Rationale

The Babol pilot needs operational speed and reliability. Premature microservices
would increase deployment, debugging and consistency costs. Domain boundaries,
events and provider adapters preserve an extraction path when scale proves the
need.
