import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const openapi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

describe('payment provider OpenAPI boundary', () => {
  it('documents safe provider, attempt and callback summaries', () => {
    expect(openapi).toContain('PaymentProviderConfigurationSummary:')
    expect(openapi).toContain('PaymentAttemptSummary:')
    expect(openapi).toContain('PaymentCallbackReceiptSummary:')
    expect(openapi).toContain('uniqueItems: true')
    expect(openapi).toContain('without a real gateway adapter')
  })

  it('exposes governance only under the authenticated admin surface', () => {
    // Governance is reachable, but only through /api/v1/admin, which every route
    // there gates on a GLOBAL governance grant.
    expect(openapi).not.toContain('/api/v1/internal/payment-providers:')
    expect(openapi).not.toContain('/api/v1/payments/providers/{providerCode}/callback:')
  })

  it('never names a credential value anywhere in the contract', () => {
    expect(openapi).not.toMatch(/credential(Value|Material)|rawSecret|authorizationHeader/)
  })
})
