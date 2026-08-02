import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260803100000_payment_ledger_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('payment and ledger foundation migration', () => {
  it('is additive and does not rewrite or remove existing business data', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|INDEX)/i)
    expect(migration).not.toMatch(/DELETE\s+FROM/i)
    expect(migration).not.toMatch(/UPDATE\s+"(Order|Quote|Payment)"\s+SET/i)
    expect(migration).toContain('does not rewrite legacy data')
  })

  it('forces tenant RLS for every new financial relation', () => {
    for (const table of [
      'Payment',
      'PaymentStateTransition',
      'LedgerAccount',
      'FinancialTransaction',
      'LedgerEntry',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON "${table}"`)
    }
  })

  it('enforces positive IRR, state history, append-only records, and deferred balance', () => {
    expect(migration).toContain('PaymentTransition_state_machine_check')
    expect(migration).toContain('Payment_history_consistency')
    expect(migration).toContain(
      'Captured payment requires a paid order and exactly one financial transaction',
    )
    expect(migration).toContain('Order_payment_projection_insert')
    expect(migration).toContain('Order_payment_projection_update')
    expect(migration).toContain('FinancialTransaction_balance_guard')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('FinancialTransaction_append_only')
    expect(migration).toContain('LedgerEntry_append_only')
    expect(migration).toContain('Payment economic identity is immutable')
    expect(migration).toContain('CHECK ("amount" > 0)')
    expect(migration).toContain('CHECK ("currency" = \'IRR\')')
  })

  it('uses tenant-scoped idempotency and composite tenant ownership', () => {
    expect(migration).toContain('Payment_tenant_customer_idempotency_key')
    expect(migration).toContain('PaymentTransition_scoped_idempotency_key')
    expect(migration).toContain('FinancialTransaction_tenant_idempotency_key')
    expect(migration).toContain('Payment_order_tenant_customer_fk')
    expect(migration).toContain('g3b_LedgerEntry_ledgerAccountId_tenant_fk')
  })
})
