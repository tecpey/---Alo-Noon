npm warn Unknown env config "http-proxy". This will stop working in the next major version of npm.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url)
const migrationUrl = new URL(
  '../prisma/migrations/20260801170000_tenant_relational_integrity_g3b/migration.sql',
  import.meta.url,
)

type TenantRelation = {
  child: string
  foreignKey: string
  parent: string
}

function tenantRelationsFromSchema(schema: string): TenantRelation[] {
  const models = new Map<string, string>()

  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    models.set(match[1], match[2])
  }

  const tenantOwnedModels = new Set(
    [...models.entries()]
      .filter(([, body]) => /^\s*tenantId\s+String\?/m.test(body))
      .map(([name]) => name),
  )
  const relations: TenantRelation[] = []

  for (const [child, body] of models) {
    if (!tenantOwnedModels.has(child)) continue

    for (const line of body.split('\n')) {
      const relation = line.match(
        /^\s*\w+\s+(\w+)\??\s+@relation\(fields:\s*\[(\w+)\],\s*references:\s*\[\w+\],\s*onDelete:\s*\w+\)/,
      )

      if (relation && tenantOwnedModels.has(relation[1])) {
        relations.push({
          child,
          foreignKey: relation[2],
          parent: relation[1],
        })
      }
    }
  }

  return relations.sort((left, right) =>
    `${left.child}.${left.foreignKey}`.localeCompare(`${right.child}.${right.foreignKey}`),
  )
}

function registeredRelationsFromMigration(sql: string): TenantRelation[] {
  return [...sql.matchAll(/    \('([^']+)', '([^']+)', '([^']+)'\)/g)]
    .map(([, child, foreignKey, parent]) => ({
      child,
      foreignKey,
      parent,
    }))
    .sort((left, right) =>
      `${left.child}.${left.foreignKey}`.localeCompare(`${right.child}.${right.foreignKey}`),
    )
}

describe('tenant relational integrity G3B', () => {
  const schema = readFileSync(schemaUrl, 'utf8')
  const sql = readFileSync(migrationUrl, 'utf8')
  const schemaRelations = tenantRelationsFromSchema(schema)
  const registeredRelations = registeredRelationsFromMigration(sql)

  it('covers every implemented tenant-owned relation exactly once', () => {
    expect(schemaRelations).toHaveLength(47)
    expect(registeredRelations).toEqual(schemaRelations)
    expect(
      new Set(registeredRelations.map(({ child, foreignKey }) => `${child}.${foreignKey}`)).size,
    ).toBe(registeredRelations.length)
  })

  it('declares parent keys, child indexes and composite tenant foreign keys', () => {
    for (const { child, foreignKey, parent } of schemaRelations) {
      expect(schema).toContain(`@@unique([id, tenantId], map: "g3b_${parent}_id_tenant_key")`)
      expect(schema).toContain(
        `@@index([${foreignKey}, tenantId], map: "g3b_${child}_${foreignKey}_tenant_idx")`,
      )
      expect(sql).toContain(`CONSTRAINT "g3b_${child}_${foreignKey}_tenant_fk"`)
      expect(sql).toContain(
        `FOREIGN KEY ("${foreignKey}", "tenantId")\n  REFERENCES "${parent}" ("id", "tenantId")`,
      )
    }
  })

  it('fails closed before DDL and preserves the G4/G5 boundary', () => {
    expect(sql.indexOf('G3B aborted:')).toBeLessThan(sql.indexOf('ADD CONSTRAINT "g3b_'))
    expect(sql).toContain('child_row."tenantId" IS NULL')
    expect(sql).toContain('parent_row."tenantId" IS NULL')
    expect(sql).toContain('child_row."tenantId" <> parent_row."tenantId"')
    expect(sql).toContain('DEFERRABLE INITIALLY IMMEDIATE')
    expect(sql).toContain('ON DELETE NO ACTION')
    expect(sql).not.toContain('SET NOT NULL')
    expect(sql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('CREATE POLICY')
    expect(sql).not.toContain('DROP CONSTRAINT')
  })
})
