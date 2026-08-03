import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260803200000_payment_provider_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('payment provider foundation migration', () => {
  it('is additive and never rewrites economic or credential material', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|INDEX)/i)
    expect(migration).not.toMatch(/DELETE\s+FROM/i)
    expect(migration).not.toMatch(/UPDATE\s+"(Payment|FinancialTransaction|LedgerEntry)"\s+SET/i)
    expect(migration).not.toMatch(/password|secretValue|credentialValue/i)
    expect(migration.indexOf('preflight failed')).toBeLessThan(
      migration.indexOf('CREATE TYPE "PaymentProviderEnvironment"'),
    )
  })

  it('forces RLS on every provider-owned relation', () => {
    for (const table of [
      'ProviderCredentialReference',
      'PaymentProviderConfiguration',
      'PaymentProviderGovernanceEvent',
      'PaymentAttempt',
      'PaymentAttemptStateTransition',
      'PaymentCallbackReceipt',
    ]) {
      expect(migration).toContain(`'${table}'`)
    }
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('CREATE POLICY tenant_isolation')
  })

  it('enforces scoped uniqueness, immutable history and one active default', () => {
    expect(migration).toContain('PaymentProvider_one_active_default_key')
    expect(migration).toContain('PaymentProvider_tenant_code_environment_version_key')
    expect(migration).toContain('PaymentProvider_adapter_spi_check')
    expect(migration).toContain('PaymentCallback_external_event_key')
    expect(migration).toContain('PaymentAttempt_provider_reference_key')
    expect(migration).toContain('PaymentProviderGovernance_append_only')
    expect(migration).toContain('PaymentAttemptTransition_append_only')
    expect(migration).toContain('Payment attempt state must match contiguous transition history')
    expect(migration).toContain('PaymentAttemptTransition_provider_reference_check')
    expect(migration).toContain(
      'Payment provider governance requires committed audit and outbox records',
    )
    expect(migration).toContain(
      'Provider credential references require committed audit and outbox records',
    )
    expect(migration).toContain(
      'Payment callback processing requires committed audit and outbox records',
    )
  })

  it('uses composite tenant ownership and safe opaque credential references', () => {
    expect(migration).toContain('g3b_PaymentAttempt_paymentId_tenant_fk')
    expect(migration).toContain('g3b_CallbackReceipt_providerConfig_tenant_fk')
    expect(migration).toContain('g3b_ProviderConfig_credentialRef_tenant_fk')
    expect(migration).toContain('vault|aws-sm|gcp-sm|local-encrypted')
    expect(migration).toContain('Provider credential references are immutable')
  })
})
