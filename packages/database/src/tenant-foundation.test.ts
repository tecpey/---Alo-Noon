import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url)
const migrationUrl = new URL(
  '../prisma/migrations/20260801090000_tenant_foundation_g2/migration.sql',
  import.meta.url,
)

describe('tenant foundation G2', () => {
  it('defines tenant identity, domain and membership records', () => {
    const schema = readFileSync(schemaUrl, 'utf8')
    expect(schema).toContain('model Tenant {')
    expect(schema).toContain('model TenantDomain {')
    expect(schema).toContain('model TenantMembership {')
    expect(schema).toContain('@@unique([tenantId, accountId])')
  })

  it('keeps tenant ownership additive until the verified G3 backfill', () => {
    expect(existsSync(migrationUrl)).toBe(true)
    const sql = readFileSync(migrationUrl, 'utf8')
    expect(sql).toContain('ALTER TABLE "Cart" ADD COLUMN "tenantId" UUID;')
    expect(sql).toContain('ALTER TABLE "Quote" ADD COLUMN "tenantId" UUID;')
    expect(sql).not.toContain('ALTER COLUMN "tenantId" SET NOT NULL')
    expect(sql).toContain("'00000000-0000-4000-8000-000000000001'")
  })

  it('adds tenant indexes to every currently implemented tenant-owned aggregate', () => {
    const sql = readFileSync(migrationUrl, 'utf8')
    const tables = [
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
    for (const table of tables) {
      expect(sql).toContain(`CREATE INDEX "${table}_tenantId_idx" ON "${table}"("tenantId");`)
    }
  })
})
