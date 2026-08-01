import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../prisma/migrations/20260801130000_tenant_backfill_g3a/migration.sql',
  import.meta.url,
)

const tenantOwnedTables = [
  'City',
  'OperationalZone',
  'ServiceArea',
  'Customer',
  'Household',
  'HouseholdMember',
  'Address',
  'Bakery',
  'BakeryBranch',
  'BakeryOperatingHours',
  'BakeryCapacitySlot',
  'ProductCategory',
  'Product',
  'ProductVariant',
  'BakeryProductOffering',
  'Cart',
  'CartItem',
  'Quote',
  'QuoteItem',
  'Order',
  'OrderItem',
  'OrderStateTransition',
  'CourierPartner',
  'Courier',
  'Vehicle',
  'DeliveryTask',
  'DeliveryAssignment',
  'Fulfillment',
  'CustomerEvent',
  'SupportCase',
  'DomainEventOutbox',
  'AuditEvent',
]

describe('tenant backfill G3A', () => {
  it('covers every currently implemented tenant-owned aggregate exactly once', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const sql = readFileSync(migrationUrl, 'utf8')

    for (const table of tenantOwnedTables) {
      expect(sql).toContain(`('${table}')`)
    }

    const registeredTables = [...sql.matchAll(/    \('([^']+)'\)/g)].map(([, table]) => table)
    expect(registeredTables).toEqual([...tenantOwnedTables].sort())
    expect(new Set(registeredTables).size).toBe(tenantOwnedTables.length)
  })

  it('fails closed on missing authority, ambiguity or incomplete backfill', () => {
    const sql = readFileSync(migrationUrl, 'utf8')

    expect(sql).toContain("'alo-noon-internal'")
    expect(sql).toContain("'alonon.ir'")
    expect(sql).toContain('foreign_tenant_rows <> 0')
    expect(sql).toContain('updated_rows <> null_before')
    expect(sql).toContain('null_after <> 0')
    expect(sql).toContain('RAISE EXCEPTION')
  })

  it('preserves the G4/G5 enforcement boundary', () => {
    const sql = readFileSync(migrationUrl, 'utf8')

    expect(sql).not.toContain('SET NOT NULL')
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('CREATE POLICY')
    expect(sql).not.toContain('DELETE FROM')
  })
})
