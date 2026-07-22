# ADR-0001: Modular Monolith for MVP

- Status: Accepted
- Date: 2026-07-23

## Decision

Start with a TypeScript modular monolith in a monorepo, backed by PostgreSQL and Redis, with explicit domain boundaries and versioned APIs.

## Rationale

The Babol pilot needs operational speed and reliability. Premature microservices would increase deployment, debugging and consistency costs. Domain boundaries, events and provider adapters preserve an extraction path when scale proves the need.
