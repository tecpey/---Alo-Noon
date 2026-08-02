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
  ])('publishes %s', (schema) => expect(openApi).toContain(schema))

  it('does not expose an untrusted public payment execution path', () => {
    expect(openApi).not.toContain('/api/v1/payments:')
    expect(openApi).toContain('no public payment-status write endpoint is exposed')
  })

  it('documents integer IRR and double-entry line constraints', () => {
    expect(openApi).toContain("amount: { type: string, pattern: '^\\d+$' }")
    expect(openApi).toContain('minItems: 2')
    expect(openApi).toContain('enum: [DEBIT, CREDIT]')
  })
})
