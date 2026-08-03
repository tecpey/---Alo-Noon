import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url)
const g3bMigrationUrl = new URL(
  '../prisma/migrations/20260801170000_tenant_relational_integrity_g3b/migration.sql',
  import.meta.url,
)
const migrationUrls = [
  g3bMigrationUrl,
  new URL(
    '../prisma/migrations/20260801234500_phase_2e_delivery_quote_foundation/migration.sql',
    import.meta.url,
  ),
  new URL(
    '../prisma/migrations/20260802120000_phase_2e_checkout_acceptance/migration.sql',
    import.meta.url,
  ),
  new URL(
    '../prisma/migrations/20260803100000_payment_ledger_foundation/migration.sql',
    import.meta.url,
  ),
  new URL(
    '../prisma/migrations/20260803160000_chart_of_accounts_provisioning/migration.sql',
    import.meta.url,
  ),
  new URL(
    '../prisma/migrations/20260803200000_payment_provider_foundation/migration.sql',
    import.meta.url,
  ),
]

type TenantRelation = {
  child: string
  foreignKey: string
  parent: string
}

const relationNameStems: Readonly<Record<string, string>> = {
  'PaymentProviderConfiguration.credentialReferenceId': 'g3b_ProviderConfig_credentialRef_tenant',
  'PaymentProviderGovernanceEvent.providerConfigurationId':
    'g3b_ProviderGovernance_providerConfig_tenant',
  'PaymentCallbackReceipt.providerConfigurationId': 'g3b_CallbackReceipt_providerConfig_tenant',
}

function relationConstraintName(child: string, foreignKey: string, suffix: 'idx' | 'fk'): string {
  const stem = relationNameStems[`${child}.${foreignKey}`] ?? `g3b_${child}_${foreignKey}_tenant`
  return `${stem}_${suffix}`
}

function tenantRelationsFromSchema(schema: string): TenantRelation[] {
  const models = new Map<string, string>()

  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const modelName = match[1]
    const modelBody = match[2]

    if (modelName && modelBody) {
      models.set(modelName, modelBody)
    }
  }

  const tenantOwnedModels = new Set(
    [...models.entries()]
      .filter(([, body]) => /^\s*tenantId\s+String\??\s+@db\.Uuid/m.test(body))
      .map(([name]) => name),
  )
  const relations: TenantRelation[] = []

  for (const [child, body] of models) {
    if (!tenantOwnedModels.has(child)) continue

    for (const line of body.split('\n')) {
      const relation = line.match(
        /^\s*\w+\s+(\w+)\??\s+@relation\((?:"[^"]+",\s*)?fields:\s*\[(\w+)\],\s*references:\s*\[\w+\],\s*onDelete:\s*\w+\)/,
      )

      const parent = relation?.[1]
      const foreignKey = relation?.[2]

      if (parent && foreignKey && tenantOwnedModels.has(parent)) {
        relations.push({
          child,
          foreignKey,
          parent,
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
    .flatMap((match) => {
      const child = match[1]
      const foreignKey = match[2]
      const parent = match[3]

      return child && foreignKey && parent ? [{ child, foreignKey, parent }] : []
    })
    .sort((left, right) =>
      `${left.child}.${left.foreignKey}`.localeCompare(`${right.child}.${right.foreignKey}`),
    )
}

describe('tenant relational integrity G3B', () => {
  const schema = readFileSync(schemaUrl, 'utf8')
  const g3bSql = readFileSync(g3bMigrationUrl, 'utf8')
  const sql = [
    g3bSql,
    ...migrationUrls.slice(1).map((migrationUrl) => readFileSync(migrationUrl, 'utf8')),
  ].join('\n')
  const schemaRelations = tenantRelationsFromSchema(schema)
  const registeredRelations = registeredRelationsFromMigration(sql)

  it('covers every implemented tenant-owned relation exactly once', () => {
    expect(schemaRelations).toHaveLength(70)
    expect(registeredRelations).toEqual(schemaRelations)
    expect(
      new Set(registeredRelations.map(({ child, foreignKey }) => `${child}.${foreignKey}`)).size,
    ).toBe(registeredRelations.length)
  })

  it('declares parent keys, child indexes and composite tenant foreign keys', () => {
    for (const { child, foreignKey, parent } of schemaRelations) {
      const indexName = relationConstraintName(child, foreignKey, 'idx')
      const foreignKeyName = relationConstraintName(child, foreignKey, 'fk')
      expect(indexName.length).toBeLessThanOrEqual(63)
      expect(foreignKeyName.length).toBeLessThanOrEqual(63)
      expect(schema).toContain(`@@unique([id, tenantId], map: "g3b_${parent}_id_tenant_key")`)
      expect(schema).toContain(`@@index([${foreignKey}, tenantId], map: "${indexName}")`)
      expect(sql).toContain(`CONSTRAINT "${foreignKeyName}"`)
      expect(sql).toContain(
        `FOREIGN KEY ("${foreignKey}", "tenantId")\n  REFERENCES "${parent}" ("id", "tenantId")`,
      )
    }
  })

  it('fails closed before DDL and preserves the G4/G5 boundary', () => {
    expect(g3bSql.indexOf('G3B aborted:')).toBeLessThan(g3bSql.indexOf('ADD CONSTRAINT "g3b_'))
    expect(g3bSql).toContain('child_row."tenantId" IS NULL')
    expect(g3bSql).toContain('parent_row."tenantId" IS NULL')
    expect(g3bSql).toContain('child_row."tenantId" <> parent_row."tenantId"')
    expect(g3bSql).toContain('DEFERRABLE INITIALLY IMMEDIATE')
    expect(g3bSql).toContain('ON DELETE NO ACTION')
    expect(g3bSql).not.toContain('SET NOT NULL')
    expect(g3bSql).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(g3bSql).not.toContain('CREATE POLICY')
    expect(g3bSql).not.toContain('DROP CONSTRAINT')
  })
})
