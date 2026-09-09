import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../prisma/migrations/20260807090000_bakery_offering_inventory_foundation/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('bakery offering inventory migration', () => {
  it('is additive and nullable with no destructive or economic DDL', () => {
    expect(migration).toContain('ADD COLUMN "stockTracked" BOOLEAN NOT NULL DEFAULT false')
    expect(migration).toContain('ADD COLUMN "stockOnHand" INTEGER')
    expect(migration).not.toMatch(
      /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE "BakeryProductOffering"/,
    )
  })

  it('pairs stock tracking and quantity so existing rows stay valid without backfill', () => {
    expect(migration).toContain('BakeryProductOffering_stock_shape_check')
    expect(migration).toContain('NOT "stockTracked" AND "stockOnHand" IS NULL')
    expect(migration).toContain('"stockTracked" AND "stockOnHand" >= 0')
  })
})
