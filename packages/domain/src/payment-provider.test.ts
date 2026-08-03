import { describe, expect, it } from 'vitest'

import {
  canonicalProviderRequest,
  redactProviderSecrets,
  requireProviderCapability,
  resolveProductionProviderAdapter,
  selectPaymentProvider,
  transitionPaymentAttempt,
  validateProviderCapabilities,
  type PaymentProviderAdapter,
  type ProviderSelectionCandidate,
} from './payment-provider'

const provider = (
  overrides: Partial<ProviderSelectionCandidate> = {},
): ProviderSelectionCandidate => ({
  id: 'provider-1',
  tenantId: 'tenant-1',
  environment: 'PRODUCTION',
  paymentContext: 'CHECKOUT',
  currency: 'IRR',
  capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
  isActive: true,
  isDefault: true,
  healthStatus: 'HEALTHY',
  ...overrides,
})

describe('payment provider domain foundation', () => {
  it('governs valid attempt transitions and rejects skipped or terminal transitions', () => {
    expect(() => transitionPaymentAttempt('CREATED', 'INITIALIZATION_PENDING')).not.toThrow()
    expect(() => transitionPaymentAttempt('VERIFICATION_PENDING', 'VERIFIED')).not.toThrow()
    expect(() => transitionPaymentAttempt('CREATED', 'VERIFIED')).toThrow('not allowed')
    expect(() => transitionPaymentAttempt('VERIFIED', 'FAILED')).toThrow('not allowed')
  })

  it('selects exactly one active healthy tenant default with the required capability', () => {
    expect(
      selectPaymentProvider([provider(), provider({ id: 'disabled', isActive: false })], {
        tenantId: 'tenant-1',
        environment: 'PRODUCTION',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        capability: 'PAYMENT_INITIALIZATION',
      }).id,
    ).toBe('provider-1')
    expect(() =>
      selectPaymentProvider([provider({ healthStatus: 'UNHEALTHY' })], {
        tenantId: 'tenant-1',
        environment: 'PRODUCTION',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        capability: 'PAYMENT_INITIALIZATION',
      }),
    ).toThrow('No eligible')
    expect(() =>
      selectPaymentProvider([provider(), provider({ id: 'provider-2' })], {
        tenantId: 'tenant-1',
        environment: 'PRODUCTION',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        capability: 'PAYMENT_INITIALIZATION',
      }),
    ).toThrow('ambiguous')
  })

  it('fails closed for unsupported capabilities and unavailable production adapters', () => {
    const adapter: PaymentProviderAdapter = {
      code: 'TEST_ONLY',
      capabilities: new Set(['PAYMENT_INITIALIZATION']),
      testOnly: true,
      mapProviderStatus: () => 'PENDING',
    }
    expect(() => requireProviderCapability(adapter, 'REFUND')).toThrow('unsupported')
    expect(() =>
      resolveProductionProviderAdapter(
        new Map([[adapter.code, adapter]]),
        adapter.code,
        'PRODUCTION',
      ),
    ).toThrow('unavailable')
    expect(
      resolveProductionProviderAdapter(new Map([[adapter.code, adapter]]), adapter.code, 'TEST'),
    ).toBe(adapter)
    expect(() => validateProviderCapabilities([])).toThrow('non-empty')
    expect(() =>
      validateProviderCapabilities(['PAYMENT_INITIALIZATION', 'PAYMENT_INITIALIZATION']),
    ).toThrow('unique')
    expect(() => validateProviderCapabilities(['PAYMENT_INITIALIZATION'])).not.toThrow()
  })

  it('produces canonical fingerprints and recursively redacts sensitive values', () => {
    expect(canonicalProviderRequest({ b: 2, a: 1 })).toBe(canonicalProviderRequest({ a: 1, b: 2 }))
    expect(canonicalProviderRequest({ amount: 1000n })).toContain('$bigint')
    expect(() => canonicalProviderRequest({ invalid: undefined })).toThrow('not canonicalizable')
    const secret = 'never-leak-provider-secret'
    const redacted = JSON.stringify(
      redactProviderSecrets({
        authorization: secret,
        nested: { signature: secret, safe: 'visible' },
      }),
    )
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain('[REDACTED]')
    expect(redacted).toContain('visible')
  })
})
