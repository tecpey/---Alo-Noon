import { describe, expect, it } from 'vitest'

import {
  AUTH_DELIVERY_ADAPTER_SPI_VERSION,
  assertAuthenticationDeliveryTransition,
  createAuthenticationDeliveryPolicy,
  createAuthenticationDeliveryRegistry,
  generateSecureOtp,
  normalizeAuthenticationDeliveryResult,
  normalizeIranianMobile,
  redactAuthenticationData,
  selectAuthenticationProvider,
  type AuthenticationDeliveryProvider,
} from './auth-delivery'

const adapter = (testOnly = false): AuthenticationDeliveryProvider => ({
  code: 'IR_SMS',
  adapterVersion: '1.0.0',
  spiVersion: AUTH_DELIVERY_ADAPTER_SPI_VERSION,
  testOnly,
  deliverOtp: async () => ({ outcome: 'DELIVERED', providerReference: 'message-1' }),
})

describe('authentication delivery domain', () => {
  it('normalizes only strict Iranian E.164 mobile numbers', () => {
    expect(normalizeIranianMobile(' +989121234567 ')).toBe('+989121234567')
    for (const invalid of ['09121234567', '+98121234567', '+98912123456', '+9891212345678']) {
      expect(() => normalizeIranianMobile(invalid)).toThrow('Iranian mobile')
    }
  })

  it('generates a fixed six-digit OTP from a bounded entropy source', () => {
    expect(generateSecureOtp(() => 0)).toBe('000000')
    expect(generateSecureOtp(() => 999_999)).toBe('999999')
    expect(() => generateSecureOtp(() => 1_000_000)).toThrow('entropy')
  })

  it('validates bounded security policy settings', () => {
    expect(
      createAuthenticationDeliveryPolicy({
        environment: 'TEST',
        otpTtlMs: 300_000,
        resendCooldownMs: 60_000,
        maxVerificationAttempts: 5,
        maxPhoneSendsPerHour: 5,
        maxIpSendsPerTenMinutes: 20,
        maxTenantSendsPerHour: 500,
        maxProviderSendsPerMinute: 300,
        circuitFailureThreshold: 5,
        circuitOpenMs: 300_000,
        invocationTimeoutMs: 5_000,
        maxPersistenceAttempts: 3,
      }).otpDigits,
    ).toBe(6)
    expect(() =>
      createAuthenticationDeliveryPolicy({
        environment: 'TEST',
        otpTtlMs: 30_000,
        resendCooldownMs: 60_000,
        maxVerificationAttempts: 5,
        maxPhoneSendsPerHour: 5,
        maxIpSendsPerTenMinutes: 20,
        maxTenantSendsPerHour: 500,
        maxProviderSendsPerMinute: 300,
        circuitFailureThreshold: 5,
        circuitOpenMs: 300_000,
        invocationTimeoutMs: 5_000,
        maxPersistenceAttempts: 3,
      }),
    ).toThrow('OTP TTL')
  })

  it('uses a deterministic versioned registry and blocks test adapters in production', () => {
    const registry = createAuthenticationDeliveryRegistry([adapter(true)])
    expect(registry.identities()).toHaveLength(1)
    expect(() =>
      registry.resolve({
        providerCode: 'IR_SMS',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        environment: 'PRODUCTION',
      }),
    ).toThrow('unavailable')
    expect(() => createAuthenticationDeliveryRegistry([adapter(), adapter()])).toThrow('duplicated')
  })

  it('selects exactly one healthy tenant default and fails closed otherwise', () => {
    const candidate = {
      id: 'a',
      tenantId: 'tenant-a',
      providerCode: 'IR_SMS',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      environment: 'TEST' as const,
      enabled: true,
      isDefault: true,
      priority: 1,
      healthStatus: 'HEALTHY' as const,
      circuitOpenedUntil: null,
    }
    expect(selectAuthenticationProvider([candidate], 'tenant-a', 'TEST', new Date()).id).toBe('a')
    expect(() =>
      selectAuthenticationProvider(
        [candidate, { ...candidate, id: 'b' }],
        'tenant-a',
        'TEST',
        new Date(),
      ),
    ).toThrow('ambiguous')
    expect(() =>
      selectAuthenticationProvider(
        [{ ...candidate, enabled: false }],
        'tenant-a',
        'TEST',
        new Date(),
      ),
    ).toThrow('No eligible')
  })

  it('normalizes safe outcomes and rejects inconsistent provider data', () => {
    expect(
      normalizeAuthenticationDeliveryResult({
        outcome: 'DELIVERED',
        providerReference: 'safe-reference',
      }),
    ).toMatchObject({ outcome: 'DELIVERED', retryable: false })
    expect(() => normalizeAuthenticationDeliveryResult({ outcome: 'DELIVERED' })).toThrow(
      'response is invalid',
    )
    expect(() =>
      normalizeAuthenticationDeliveryResult({
        outcome: 'REJECTED',
        providerReference: 'unexpected',
      }),
    ).toThrow('response is invalid')
  })

  it('permits one initialization finalization and redacts sensitive structures', () => {
    expect(() => assertAuthenticationDeliveryTransition('INITIALIZED', 'UNKNOWN')).not.toThrow()
    expect(() => assertAuthenticationDeliveryTransition('DELIVERED', 'UNKNOWN')).toThrow(
      'not allowed',
    )
    expect(
      redactAuthenticationData({
        mobileE164: '+989121234567',
        otp: '123456',
        nested: { credential: 'secret', normalizedCode: 'DELIVERED' },
      }),
    ).toEqual({
      mobileE164: '[REDACTED]',
      otp: '[REDACTED]',
      nested: { credential: '[REDACTED]', normalizedCode: 'DELIVERED' },
    })
  })
})
