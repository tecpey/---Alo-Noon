import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260802120000_phase_2e_checkout_acceptance/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('Phase 2E checkout migration', () => {
  it('keeps rollout-sensitive provenance nullable and expires incomplete active quotes', () => {
    expect(migration).toContain('ADD COLUMN "deliveryDistanceMeters" INTEGER')
    expect(migration).not.toContain('"deliveryDistanceMeters" INTEGER NOT NULL')
    expect(migration).toContain('SET "status" = \'EXPIRED\'')
    expect(migration).not.toContain('SET "deliveryFeeAmount"')
    expect(migration).not.toContain('SET "productNameFaSnapshot"')
  })

  it('enforces scoped idempotency and relational capacity provenance', () => {
    expect(migration).toContain('"Quote_tenant_customer_idempotency_key"')
    expect(migration).toContain('"Order_tenant_customer_idempotency_key"')
    expect(migration).toContain('"Address_tenant_customer_idempotency_key"')
    expect(migration).toContain('"Order_capacity_tenant_branch_fk"')
    expect(migration).toContain('"Address_serviceArea_tenant_zone_fk"')
  })

  it('fails closed on ambiguous active rules and protects referenced economics', () => {
    expect(migration.indexOf('Phase 2E checkout aborted')).toBeLessThan(
      migration.indexOf('ALTER TABLE "Address"'),
    )
    expect(migration).toContain('Multiple active delivery pricing rules exist for one scope')
    expect(migration).toContain('DeliveryPricingRule_one_active_zone_scope_key')
    expect(migration).toContain('DeliveryPricingRule_one_active_city_scope_key')
    expect(migration).toContain('DeliveryPricingRule_referenced_economics_immutable')
    expect(migration).toContain('Referenced delivery pricing economics are immutable')
  })
})
