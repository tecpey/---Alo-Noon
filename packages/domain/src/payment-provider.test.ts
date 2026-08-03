import { describe, expect, it } from 'vitest'

import {
  canonicalProviderRequest,
  createPaymentProviderAdapterRegistry,
  redactProviderSecrets,
  requireProviderCapability,
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
      adapterVersion: '1.0.0',
      spiVersion: 1,
      capabilities: new Set(['PAYMENT_INITIALIZATION']),
      testOnly: true,
      mapProviderStatus: () => 'PENDING',
      initializePayment: async () => ({ normalizedOutcome: 'PENDING' }),
    }
    const registry = createPaymentProviderAdapterRegistry([adapter])
    expect(() => requireProviderCapability(adapter, 'REFUND')).toThrow('unsupported')
    expect(() =>
      registry.resolve({
        providerCode: adapter.code,
        adapterVersion: adapter.adapterVersion,
        adapterSpiVersion: 1,
        environment: 'PRODUCTION',
      }),
    ).toThrow('unavailable')
    expect(
      registry.resolve({
        providerCode: adapter.code,
        adapterVersion: adapter.adapterVersion,
        adapterSpiVersion: 1,
        environment: 'TEST',
        capability: 'PAYMENT_INITIALIZATION',
      }),
    ).toBe(adapter)
    expect(() =>
      registry.resolve({
        providerCode: adapter.code,
        adapterVersion: '2.0.0',
        adapterSpiVersion: 1,
        environment: 'TEST',
      }),
    ).toThrow('unavailable')
    expect(() => createPaymentProviderAdapterRegistry([adapter, adapter])).toThrow('duplicated')
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

  it('resolves one hundred isolated adapters and permits governed version coexistence', () => {
    const adapters: PaymentProviderAdapter[] = Array.from({ length: 100 }, (_, index) => ({
      code: `PROVIDER_${String(index).padStart(3, '0')}`,
      adapterVersion: '1.0.0',
      spiVersion: 1,
      capabilities: new Set(['PAYMENT_INQUIRY']),
      mapProviderStatus: () => 'PENDING',
      inquirePayment: async () => ({ normalizedOutcome: 'PENDING' }),
    }))
    adapters.push({ ...adapters[0]!, adapterVersion: '2.0.0' })
    const registry = createPaymentProviderAdapterRegistry(adapters)
    expect(registry.identities()).toHaveLength(101)
    expect(
      registry.resolve({
        providerCode: 'PROVIDER_000',
        adapterVersion: '2.0.0',
        adapterSpiVersion: 1,
        environment: 'PRODUCTION',
        capability: 'PAYMENT_INQUIRY',
      }).adapterVersion,
    ).toBe('2.0.0')
  })
})
