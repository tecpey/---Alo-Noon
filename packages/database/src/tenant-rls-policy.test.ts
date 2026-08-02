import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url)
const migrationsUrl = new URL('../prisma/migrations/', import.meta.url)
const rlsControlPlaneModels = new Set(['TenantDomain', 'TenantMembership'])

function tenantOwnedModels(schema: string): string[] {
  return [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
    .flatMap((match) => {
      const name = match[1]
      const body = match[2]
      return name &&
        body &&
        !rlsControlPlaneModels.has(name) &&
        /^\s*tenantId\s+String\??\s+@db\.Uuid/m.test(body)
        ? [name]
        : []
    })
    .sort()
}

function migrationSql(): Map<string, string> {
  return new Map(
    readdirSync(migrationsUrl, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        entry.name,
        readFileSync(new URL(`${entry.name}/migration.sql`, migrationsUrl), 'utf8'),
      ]),
  )
}

function g5DynamicTables(sql: string): string[] {
  const enableIndex = sql.indexOf('ALTER TABLE %I ENABLE ROW LEVEL SECURITY')
  const valuesStart = sql.lastIndexOf('FROM (VALUES', enableIndex)
  const valuesEnd = sql.indexOf(') AS owned(table_name)', valuesStart)

  if (enableIndex < 0 || valuesStart < 0 || valuesEnd < 0) return []

  return [...sql.slice(valuesStart, valuesEnd).matchAll(/\('([^']+)'\)/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
}

function directTables(sql: string, statement: RegExp): string[] {
  return [...sql.matchAll(statement)].flatMap((match) => (match[1] ? [match[1]] : []))
}

describe('tenant RLS policy coverage', () => {
  const schema = readFileSync(schemaUrl, 'utf8')
  const migrations = migrationSql()
  const allSql = [...migrations.values()].join('\n')
  const g5Sql =
    [...migrations.entries()].find(([name]) => name.includes('tenant_rls_isolation_g5'))?.[1] ?? ''
  const dynamicTables = g5DynamicTables(g5Sql)

  it('enables, forces and policies every tenant-owned business model exactly once', () => {
    const expected = tenantOwnedModels(schema)
    const coverage = [
      [
        'ENABLE ROW LEVEL SECURITY',
        [
          ...dynamicTables,
          ...directTables(allSql, /ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/g),
        ],
      ],
      [
        'FORCE ROW LEVEL SECURITY',
        [
          ...dynamicTables,
          ...directTables(allSql, /ALTER TABLE "(\w+)" FORCE ROW LEVEL SECURITY/g),
        ],
      ],
      [
        'tenant_isolation policy',
        [...dynamicTables, ...directTables(allSql, /CREATE POLICY tenant_isolation ON "(\w+)"/g)],
      ],
    ] as const

    for (const [label, registered] of coverage) {
      expect(registered, `${label} must not contain duplicate table registrations`).toHaveLength(
        new Set(registered).size,
      )
      expect([...registered].sort(), `${label} must cover every tenant-owned model`).toEqual(
        expected,
      )
    }
  })
})
