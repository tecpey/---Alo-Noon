import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  createProviderExecutionPolicy,
  initializationAttemptStates,
  normalizeInitializationResult,
  validateInitializationAdapter,
} from './payment-execution'
import type { PaymentProviderAdapter } from './payment-provider'

const now = new Date('2026-08-04T09:00:00.000Z')

function adapter(overrides: Partial<PaymentProviderAdapter> = {}): PaymentProviderAdapter {
  return {
    code: 'TEST_GATEWAY',
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set(['PAYMENT_INITIALIZATION']),
    mapProviderStatus: () => 'PENDING',
    initializePayment: async () => ({ outcome: 'ACCEPTED', providerReference: 'provider-1' }),
    ...overrides,
  }
}

describe('payment execution policy', () => {
  it('fixes the provider-agnostic checkout initialization boundary', () => {
    expect(
      createProviderExecutionPolicy({
        environment: 'PRODUCTION',
        maxPersistenceAttempts: 3,
        invocationTimeoutMs: 10_000,
      }),
    ).toEqual({
      capability: 'PAYMENT_INITIALIZATION',
      environment: 'PRODUCTION',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      requireHealthyProvider: true,
      maxPersistenceAttempts: 3,
      invocationTimeoutMs: 10_000,
    })
  })

  it('rejects unsafe retry and timeout metadata', () => {
    expect(() =>
      createProviderExecutionPolicy({
        environment: 'TEST',
        maxPersistenceAttempts: 0,
        invocationTimeoutMs: 10_000,
      }),
    ).toThrowError(DomainError)
    expect(() =>
      createProviderExecutionPolicy({
        environment: 'TEST',
        maxPersistenceAttempts: 2,
        invocationTimeoutMs: 99,
      }),
    ).toThrowError(DomainError)
  })
})

describe('provider initialization boundary', () => {
  it('rejects test adapters in production and missing initialization capability', () => {
    expect(() => validateInitializationAdapter(adapter({ testOnly: true }), 'PRODUCTION')).toThrow(
      'Test-only payment adapters cannot execute in production',
    )
    const withoutInitialization: PaymentProviderAdapter = {
      code: 'TEST_GATEWAY',
      adapterVersion: '1.0.0',
      spiVersion: 1,
      capabilities: new Set(['PAYMENT_INQUIRY']),
      mapProviderStatus: () => 'PENDING',
    }
    expect(() => validateInitializationAdapter(withoutInitialization, 'TEST')).toThrow(
      'Payment initialization capability is unavailable',
    )
  })

  it('normalizes accepted and customer-action results without provider payloads', () => {
    expect(
      normalizeInitializationResult(
        { outcome: 'ACCEPTED', providerReference: '  provider-1  ' },
        now,
      ),
    ).toEqual({
      outcome: 'ACCEPTED',
      providerReference: 'provider-1',
      customerActionUrl: null,
      actionExpiresAt: null,
      failureCode: null,
      retryable: false,
      customerMessageKey: null,
    })

    const actionExpiresAt = new Date(now.getTime() + 60_000)
    expect(
      normalizeInitializationResult(
        {
          outcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: 'provider-2',
          customerActionUrl: 'https://pay.example.test/action?token=opaque',
          actionExpiresAt,
          customerMessageKey: 'payment.continue',
        },
        now,
      ),
    ).toMatchObject({
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      customerActionUrl: 'https://pay.example.test/action?token=opaque',
      actionExpiresAt,
      retryable: false,
    })
    expect(initializationAttemptStates('CUSTOMER_ACTION_REQUIRED')).toEqual([
      'INITIALIZED',
      'CUSTOMER_ACTION_REQUIRED',
    ])
  })

  it('normalizes explicit failures and rejects unsafe or inconsistent output', () => {
    expect(
      normalizeInitializationResult(
        {
          outcome: 'RETRYABLE_FAILURE',
          normalizedCode: 'PROVIDER_TEMPORARY_FAILURE',
          retryable: true,
          customerMessageKey: 'payment.retry_later',
        },
        now,
      ),
    ).toMatchObject({
      outcome: 'RETRYABLE_FAILURE',
      failureCode: 'PROVIDER_TEMPORARY_FAILURE',
      retryable: true,
    })
    expect(initializationAttemptStates('RETRYABLE_FAILURE')).toEqual(['FAILED'])

    for (const result of [
      { outcome: 'ACCEPTED' as const },
      {
        outcome: 'CUSTOMER_ACTION_REQUIRED' as const,
        providerReference: 'provider-3',
        customerActionUrl: 'http://unsafe.example.test',
      },
      { outcome: 'UNKNOWN' as const, normalizedCode: 'unsafe-code' },
      {
        outcome: 'PERMANENT_FAILURE' as const,
        normalizedCode: 'PROVIDER_REJECTED',
        providerReference: 'must-not-leak',
      },
    ]) {
      expect(() => normalizeInitializationResult(result, now)).toThrowError(DomainError)
    }
  })
})
