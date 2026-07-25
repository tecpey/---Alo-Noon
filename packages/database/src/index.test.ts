import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { Prisma } from './index'

describe('database package', () => {
  it('exports the generated Phase 1 Prisma model', () => {
    expect(Prisma.dmmf.datamodel.models.map((model) => model.name)).toEqual(
      expect.arrayContaining([
        'City',
        'OperationalZone',
        'Customer',
        'BakeryBranch',
        'ProductVariant',
        'OrderStateTransition',
        'Fulfillment',
        'DeliveryTask',
        'DomainEventOutbox',
        'AuditEvent',
      ]),
    )
  })

  it('includes the reviewed Phase 1 migration', () => {
    const migration = new URL(
      '../prisma/migrations/20260725010000_phase_1_domain_foundation/migration.sql',
      import.meta.url,
    )

    expect(existsSync(migration)).toBe(true)

    const sql = readFileSync(migration, 'utf8')

    expect(sql).toContain(
      'Phase 1 migration requires empty Phase 0 placeholder tables; export and backfill data explicitly before retrying',
    )
    expect(sql).toContain('CREATE TABLE "DomainEventOutbox"')
    expect(sql).toContain('ADD CONSTRAINT "ProductVariant_classification_check"')
  })
})
