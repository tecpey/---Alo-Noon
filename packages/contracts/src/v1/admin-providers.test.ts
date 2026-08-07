import { describe, expect, it } from 'vitest'

import {
  adminAuthDeliveryConfigurationCreateSchema,
  adminAuthDeliveryHealthSchema,
  adminPaymentProviderConfigurationCreateSchema,
  adminPaymentProviderGovernanceSchema,
  adminPaymentProviderHealthSchema,
  adminProviderCredentialCreateSchema,
} from './admin-providers'

const credential = {
  providerCode: 'DEMOPAY',
  reference: 'local-encrypted://DEMOPAY',
  keyVersion: 'v1',
  metadata: {},
  idempotencyKey: 'admin-credential-key-0001',
}

const smsConfiguration = {
  providerCode: 'DEMOSMS',
  adapterVersion: '1.0.0',
  environment: 'TEST',
  credentialReference: 'env://AUTH_SMS_DEMOSMS_API_KEY',
  senderReference: '3000',
  templateReference: 'otp-fa',
  enabled: true,
  isDefault: true,
  reason: 'Soft launch provisioning',
}

describe('admin provider governance contracts', () => {
  it('accepts a credential named by an approved reference scheme', () => {
    expect(adminProviderCredentialCreateSchema.parse(credential).reference).toBe(
      'local-encrypted://DEMOPAY',
    )
  })

  it.each([
    ['a plaintext environment variable', 'env://DEMOPAY_API_KEY'],
    ['an unrecognised scheme', 'file:///etc/demopay.key'],
    ['a bare secret', 'sk_live_0123456789abcdef'],
  ])('rejects %s as a payment credential reference', (_label, reference) => {
    expect(
      adminProviderCredentialCreateSchema.safeParse({ ...credential, reference }).success,
    ).toBe(false)
  })

  it.each([
    ['a tenant override', { tenantId: '00000000-0000-4000-8000-000000000001' }],
    ['an inline secret', { apiKey: 'sk_live_0123456789abcdef' }],
    ['an actor override', { actorId: '00000000-0000-4000-8000-0000000000a1' }],
  ])('rejects %s smuggled alongside a credential command', (_label, extra) => {
    expect(adminProviderCredentialCreateSchema.safeParse({ ...credential, ...extra }).success).toBe(
      false,
    )
  })

  it('requires a substantive reason on every governance mutation', () => {
    const withReason = (reason: string) => ({
      targetActive: true,
      makeDefault: true,
      idempotencyKey: 'admin-governance-key-0001',
      reason,
    })
    expect(adminPaymentProviderGovernanceSchema.safeParse(withReason('Activate')).success).toBe(
      true,
    )
    expect(adminPaymentProviderGovernanceSchema.safeParse(withReason('ok')).success).toBe(false)
  })

  it('lets a payment gateway be reset to UNKNOWN but never an SMS provider', () => {
    const command = { healthStatus: 'UNKNOWN', reason: 'Provider state is no longer observed' }
    expect(adminPaymentProviderHealthSchema.safeParse(command).success).toBe(true)
    // Nothing may claim an SMS provider was never observed once it has been.
    expect(adminAuthDeliveryHealthSchema.safeParse(command).success).toBe(false)
  })

  it('carries a credential reference id, never a reference, on a gateway configuration', () => {
    const parsed = adminPaymentProviderConfigurationCreateSchema.parse({
      providerCode: 'DEMOPAY',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      merchantReference: 'merchant-1',
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION'],
      credentialReferenceId: '00000000-0000-4000-8000-0000000000d1',
      idempotencyKey: 'admin-configuration-key-0001',
      reason: 'Soft launch provisioning',
    })
    expect(parsed).not.toHaveProperty('reference')
    expect(parsed.credentialReferenceId).toBe('00000000-0000-4000-8000-0000000000d1')
  })

  it('accepts an SMS configuration and leaves priority to the service default', () => {
    const parsed = adminAuthDeliveryConfigurationCreateSchema.parse(smsConfiguration)
    expect(parsed.priority).toBeUndefined()
    expect(
      adminAuthDeliveryConfigurationCreateSchema.parse({ ...smsConfiguration, priority: 10 })
        .priority,
    ).toBe(10)
  })

  it.each([
    ['an out-of-range priority', { priority: 0 }],
    ['an unbounded priority', { priority: 5000 }],
    ['a non-integer priority', { priority: 1.5 }],
    ['an unrecognised credential scheme', { credentialReference: 'http://sms.example/key' }],
  ])('rejects an SMS configuration with %s', (_label, override) => {
    expect(
      adminAuthDeliveryConfigurationCreateSchema.safeParse({ ...smsConfiguration, ...override })
        .success,
    ).toBe(false)
  })
})
