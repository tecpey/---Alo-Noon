# Communication persistence and governance plan

This document intentionally reserves the next bounded implementation phase after PR #37.

## Scope

- persistent communication providers, templates, versions, bindings, and event mappings;
- tenant/platform scope with additive PostgreSQL migrations;
- forced RLS and composite tenant foreign keys;
- authorization-grant checks separate from tenant context;
- immutable version history and append-only delivery attempts;
- atomic audit/outbox writes;
- no raw secrets, OTP values, or recipient identifiers;
- PostgreSQL integration and cross-tenant negative tests.

## Dependency

Implementation must begin only after PR #37 is green and merged. This file is planning-only and introduces no runtime behavior.
