import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const openapi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

describe('payment execution OpenAPI boundary', () => {
  it('publishes only the authoritative initialization command and normalized response', () => {
    expect(openapi).toContain('/api/v1/payments/initialize:')
    expect(openapi).toContain('required: [paymentId, idempotencyKey]')
    expect(openapi).toContain('PaymentExecutionSummary:')
    expect(openapi).toContain('PAYMENT_INITIALIZATION')
    const command = openapi.slice(
      openapi.indexOf('PaymentExecutionInitialize:'),
      openapi.indexOf('PaymentExecutionSummary:'),
    )
    expect(command).not.toMatch(
      /tenantId|customerId|providerConfigurationId|amount|currency|credentialReference/,
    )
  })

  it('does not add callback, inquiry, capture, or provider-specific execution routes', () => {
    expect(openapi).not.toContain('/api/v1/payments/capture:')
    expect(openapi).not.toContain('/api/v1/payments/inquiry:')
    expect(openapi).not.toContain('/api/v1/payments/providers/{providerCode}/callback:')
    expect(openapi).not.toMatch(/zarinpal|idpay|nextpay|stripe/i)
    expect(openapi).not.toMatch(/credential(Value|Material)|rawProviderPayload|authorizationHeader/)
  })
})
