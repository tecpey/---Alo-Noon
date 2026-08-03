import { describe, expect, it } from 'vitest'

import {
  paymentCallbackIntakeSchema,
  paymentExecutionInitializeSchema,
  paymentExecutionSummarySchema,
  paymentProviderConfigurationCreateSchema,
  paymentProviderConfigurationSummarySchema,
  providerCredentialReferenceCreateSchema,
} from './payment-providers'

describe('payment provider contracts', () => {
  it('accepts safe configuration and opaque credential references', () => {
    expect(
      providerCredentialReferenceCreateSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        reference: 'vault://alo-noon/tenant/provider/merchant',
        keyVersion: 'v1',
      }),
    ).not.toHaveProperty('secret')
    expect(
      paymentProviderConfigurationCreateSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        merchantReference: 'merchant-safe-reference',
        environment: 'TEST',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        callbackPolicy: 'SIGNED_ONLY',
        capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
        credentialReferenceId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'provider-configuration-0001',
      }).capabilities,
    ).toHaveLength(2)
    expect(() =>
      paymentProviderConfigurationCreateSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        merchantReference: 'merchant-safe-reference',
        environment: 'TEST',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        callbackPolicy: 'SIGNED_ONLY',
        capabilities: ['PAYMENT_INITIALIZATION', 'PAYMENT_INITIALIZATION'],
        credentialReferenceId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'provider-configuration-0002',
      }),
    ).toThrow('must be unique')
  })

  it('rejects plaintext-like references and never exposes reference material in summaries', () => {
    expect(() =>
      providerCredentialReferenceCreateSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        reference: 'plaintext-password',
        keyVersion: 'v1',
      }),
    ).toThrow()
    const parsed = paymentProviderConfigurationSummarySchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      providerCode: 'FUTURE_GATEWAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      merchantReference: 'merchant-safe-reference',
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION'],
      credentialReferenceId: '00000000-0000-4000-8000-000000000002',
      isActive: false,
      isDefault: false,
      healthStatus: 'UNKNOWN',
      governanceVersion: 1,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    })
    expect(parsed).not.toHaveProperty('credentialReference')
  })

  it('bounds callback headers and payloads at the contract boundary', () => {
    expect(
      paymentCallbackIntakeSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        externalEventId: 'event-1',
        approvedHeaders: { 'x-provider-timestamp': '1234' },
        canonicalPayload: { authority: 'opaque-reference' },
        receivedAt: '2026-08-03T00:00:00.000Z',
        idempotencyKey: 'callback-intake-event-0001',
      }).approvedHeaders,
    ).not.toHaveProperty('authorization')
    expect(() =>
      paymentCallbackIntakeSchema.parse({
        providerCode: 'FUTURE_GATEWAY',
        externalEventId: 'event-1',
        approvedHeaders: { authorization: 'Bearer must-not-persist' },
        canonicalPayload: {},
        receivedAt: '2026-08-03T00:00:00.000Z',
        idempotencyKey: 'callback-intake-event-0002',
      }),
    ).toThrow('not approved')
  })
})

describe('payment execution contracts', () => {
  it('accepts only the caller-controlled payment and idempotency fields', () => {
    expect(
      paymentExecutionInitializeSchema.parse({
        paymentId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'payment-execution-0001',
      }),
    ).toEqual({
      paymentId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'payment-execution-0001',
    })
    expect(
      paymentExecutionInitializeSchema.safeParse({
        paymentId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'payment-execution-0001',
        providerConfigurationId: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false)
  })

  it('returns only normalized, redacted execution output', () => {
    const result = paymentExecutionSummarySchema.parse({
      paymentAttemptId: '00000000-0000-4000-8000-000000000001',
      paymentId: '00000000-0000-4000-8000-000000000002',
      providerConfigurationId: '00000000-0000-4000-8000-000000000003',
      providerCode: 'TEST_GATEWAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      state: 'CUSTOMER_ACTION_REQUIRED',
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'provider-reference',
      customerAction: {
        url: 'https://pay.example.test/action?token=opaque',
        expiresAt: '2026-08-04T10:00:00.000Z',
      },
      failure: null,
      correlationId: '00000000-0000-4000-8000-000000000004',
      replayed: false,
      createdAt: '2026-08-04T09:00:00.000Z',
      updatedAt: '2026-08-04T09:01:00.000Z',
    })
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('rawProviderPayload')
  })
})
