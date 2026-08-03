import { describe, expect, it } from 'vitest'

import {
  authenticationDeliveryEventPayloadSchema,
  authenticationDeliverySuppressedEventPayloadSchema,
  otpIdempotencyKeySchema,
  otpRequestSchema,
} from '..'

describe('authentication delivery contracts', () => {
  it('keeps the public request limited to a strict Iranian mobile number', () => {
    expect(otpRequestSchema.parse({ mobileE164: '+989121234567' })).toEqual({
      mobileE164: '+989121234567',
    })
    expect(() => otpRequestSchema.parse({ mobileE164: '09121234567' })).toThrow()
    expect(() =>
      otpRequestSchema.parse({
        mobileE164: '+989121234567',
        tenantId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toThrow()
    expect(Object.keys(otpRequestSchema.parse({ mobileE164: '+989121234567' }))).toEqual([
      'mobileE164',
    ])
  })

  it('validates bounded replay keys and secret-free delivery events', () => {
    expect(otpIdempotencyKeySchema.parse('otp-request-key-0001')).toBe('otp-request-key-0001')
    const payload = authenticationDeliveryEventPayloadSchema.parse({
      challengeId: '11111111-1111-4111-8111-111111111111',
      deliveryAttemptId: '22222222-2222-4222-8222-222222222222',
      providerConfigurationId: '33333333-3333-4333-8333-333333333333',
      providerCode: 'IR_SMS',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      state: 'DELIVERED',
      safeFailureCode: null,
      version: 2,
    })
    expect(payload).not.toHaveProperty('otp')
    expect(payload).not.toHaveProperty('mobileE164')
    expect(payload).not.toHaveProperty('credentialReference')
    expect(
      authenticationDeliverySuppressedEventPayloadSchema.parse({
        policyDecision: 'RATE_LIMIT',
      }),
    ).toEqual({ policyDecision: 'RATE_LIMIT' })
  })
})
