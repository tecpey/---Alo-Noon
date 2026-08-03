import { describe, expect, it } from 'vitest'

import { isRetryableProviderConflict } from './modules/payment-provider'

describe('payment provider conflict classification', () => {
  it('retries serialization and only narrowly identified idempotency races', () => {
    expect(isRetryableProviderConflict({ code: 'P2034' })).toBe(true)
    expect(isRetryableProviderConflict({ code: '40001' })).toBe(true)
    expect(isRetryableProviderConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true)
    expect(
      isRetryableProviderConflict({
        code: 'P2002',
        meta: { constraint: 'PaymentCallback_external_event_key' },
      }),
    ).toBe(true)
    expect(isRetryableProviderConflict({ code: 'P2002' })).toBe(false)
    expect(
      isRetryableProviderConflict({
        code: 'P2002',
        meta: { constraint: 'PaymentProvider_one_active_default_key' },
      }),
    ).toBe(false)
    expect(
      isRetryableProviderConflict({
        code: 'P2002',
        meta: { target: ['tenantId', 'providerConfigurationId', 'externalEventId'] },
      }),
    ).toBe(true)
  })
})
