import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260805100000_production_auth_delivery_foundation/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('production authentication delivery migration', () => {
  it('is additive for current economic and authentication history', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i)
    expect(migration).not.toMatch(/DELETE\s+FROM/i)
    expect(migration).not.toMatch(/UPDATE\s+"(Payment|FinancialTransaction|LedgerEntry|Order)"/i)
    expect(migration).toContain(`WHERE "status" = 'PENDING'`)
    expect(migration).toContain(`SET "status" = 'INVALIDATED'`)
  })

  it('forces tenant RLS and composite tenant integrity', () => {
    for (const table of [
      'AuthDeliveryProviderConfiguration',
      'AuthOtpChallenge',
      'AuthOtpDeliveryAttempt',
      'AuthAbuseEvent',
      'TenantMembership',
      'AuthSession',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON "${table}"`)
    }
    expect(migration).toContain('AuthOtpDeliveryAttempt_challenge_tenant_fkey')
    expect(migration).toContain('AuthOtpDeliveryAttempt_provider_tenant_fkey')
    expect(migration).toContain('AuthAbuseEvent_provider_tenant_fkey')
    expect(migration).toContain('TenantMembership_customer_tenant_fkey')
  })

  it('enforces idempotency, active-challenge, provider and append-only guards', () => {
    expect(migration).toContain('auth_challenge_idempotency_key')
    expect(migration).toContain('auth_challenge_one_active_mobile_key')
    expect(migration).toContain('auth_provider_one_default_key')
    expect(migration).toContain('auth_attempt_provider_reference_key')
    expect(migration).toContain('Authentication OTP challenges cannot be deleted')
    expect(migration).toContain('Authentication delivery attempt is append-only after finalization')
    expect(migration).toContain('Authentication abuse history is append-only')
  })

  it('contains no plaintext credential or OTP value column', () => {
    expect(migration).not.toMatch(/"(otp|code|credential|apiKey|password|secret)Value"/i)
    expect(migration).toContain('"codeDigest" VARCHAR(64)')
    expect(migration).toContain('"credentialReference" VARCHAR(255)')
  })
})
