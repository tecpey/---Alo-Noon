# ADR-0003: Multi-city and Partner Abstraction from Day One

- Status: Accepted
- Date: 2026-07-23

## Decision

Babol is launch configuration, not a hardcoded platform assumption. Bakeries,
suppliers and logistics providers integrate through city-aware configuration and
provider adapters.

## Consequence

Core orders must not depend on a specific courier center, bakery implementation
or city pricing formula.
