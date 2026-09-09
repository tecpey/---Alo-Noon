import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const openApi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

describe('payment and ledger OpenAPI foundation', () => {
  it.each([
    'PaymentAggregateState:',
    'PaymentSummary:',
    'LedgerAccountType:',
    'LedgerEntrySide:',
    'FinancialTransactionSummary:',
    'PaymentCreatedEventPayload:',
    'PaymentStateChangedEventPayload:',
    'FinancialTransactionPostedEventPayload:',
    'LedgerAccountGovernanceAction:',
    'LedgerAccountSummary:',
    'TenantFinancialBootstrapSummary:',
    'FinancialChartProvisionedEventPayload:',
    'LedgerAccountStateChangedEventPayload:',
  ])('publishes %s', (schema) => expect(openApi).toContain(schema))

  /**
   * A customer can now open the payment for their own order and read it back,
   * so the absence of `/api/v1/payments` is no longer the invariant. What has
   * to stay true is narrower and more important: nothing a client sends can
   * name an amount or assert a state. The amount comes from the order; the
   * state comes from settlement, driven by the gateway's own answer.
   */
  it('lets a client open and read a payment, but never price or settle one', () => {
    expect(openApi).toContain('/api/v1/payments:')
    expect(openApi).toContain('/api/v1/payments/{paymentId}:')

    // The only payment a client may describe, and it describes neither.
    const command = openApi.slice(
      openApi.indexOf('    PaymentCheckoutStart:'),
      openApi.indexOf('    PaymentEnvelope:'),
    )
    expect(command).toContain('orderId')
    expect(command).toContain('idempotencyKey')
    expect(command).not.toMatch(/amount|state|status/i)
    expect(command).toContain('additionalProperties: false')

    // No route exists through which a state could be asserted at all.
    expect(openApi).not.toContain('/api/v1/payments/{paymentId}/state')
    expect(openApi).not.toContain('/api/v1/payments/{paymentId}/capture')
    expect(openApi).not.toContain('/api/v1/payments/capture')

    // Ledger governance stays entirely internal.
    expect(openApi).not.toContain('/api/v1/financial-operations:')
    expect(openApi).toContain('no ledger-governance write endpoint is')
  })

  it('documents integer IRR and double-entry line constraints', () => {
    expect(openApi).toContain("amount: { type: string, pattern: '^\\d+$' }")
    expect(openApi).toContain('minItems: 2')
    expect(openApi).toContain('enum: [DEBIT, CREDIT]')
  })
})
