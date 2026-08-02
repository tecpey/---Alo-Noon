import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260803160000_chart_of_accounts_provisioning/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('chart-of-accounts provisioning migration', () => {
  it('is additive, performs preflight before DDL and never rewrites financial history', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|INDEX)/i)
    expect(migration).not.toMatch(/DELETE\s+FROM/i)
    expect(migration).not.toMatch(/UPDATE\s+"(FinancialTransaction|LedgerEntry|Payment)"\s+SET/i)
    expect(migration.indexOf('Chart provisioning preflight failed')).toBeLessThan(
      migration.indexOf('CREATE TYPE "LedgerAccountGovernanceAction"'),
    )
    expect(migration).toContain('does not rewrite entries or economic values')
  })

  it('provisions all deterministic v1 templates for existing and future tenants', () => {
    for (const code of [
      'A_1000',
      'A_1100_CASH_CLEARING',
      'L_2000',
      'L_2100_PAYMENT_CLEARING',
      'L_2200_BAKERY_PAYABLE',
      'L_2300_COURIER_PAYABLE',
      'E_3000',
      'E_3100_RETAINED_EARNINGS',
      'R_4000',
      'R_4100_PRODUCT_SALES',
      'R_4200_DELIVERY',
      'X_5000',
      'X_5100_DELIVERY',
      'X_5200_PAYMENT_PROCESSING',
    ]) {
      expect(migration).toContain(`'${code}'`)
    }
    expect(migration).toContain('Tenant_financial_chart_bootstrap')
    expect(migration).toContain('ON CONFLICT ("tenantId", "templateVersion") DO NOTHING')
    expect(migration).toContain('template_count CONSTANT INTEGER := 14')
  })

  it('forces tenant isolation and composite ownership for new financial relations', () => {
    for (const table of ['TenantFinancialBootstrap', 'LedgerAccountGovernanceEvent']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON "${table}"`)
    }
    expect(migration).toContain('g3b_LedgerAccount_parentId_tenant_fk')
    expect(migration).toContain('g3b_LedgerAccountGovernanceEvent_ledgerAccountId_tenant_fk')
    expect(migration).toContain('DEFERRABLE INITIALLY IMMEDIATE')
  })

  it('enforces immutable system identity, hierarchy, governance and posting eligibility', () => {
    expect(migration).toContain('Ledger account identity is immutable')
    expect(migration).toContain('Ledger accounts cannot be deleted')
    expect(migration).toContain('LedgerAccount_hierarchy_guard')
    expect(migration).toContain('LedgerAccount_governance_consistency')
    expect(migration).toContain('LedgerGovernance_append_only')
    expect(migration).toContain('LedgerAccount_active_hierarchy')
    expect(migration).toContain(
      'Ledger governance changes require committed audit and outbox records',
    )
    expect(migration).toContain('OR NOT account."isPostable"')
    expect(migration).toContain('REVOKE ALL ON FUNCTION provision_tenant_financial_chart')
    expect(migration).toContain('Financial bootstrap tenant context mismatch')
  })
})
