import { describe, expect, it } from 'vitest'

import {
  financialChartProvisionedEventPayloadSchema,
  ledgerAccountStateChangedEventPayloadSchema,
  ledgerAccountSummarySchema,
  tenantFinancialBootstrapSummarySchema,
} from './index'

const tenantId = '00000000-0000-4000-8000-000000000001'
const accountId = 'cc1f7233-e98e-460c-bd73-730df4455eb1'
const correlationId = 'bc8b4a51-6ca7-4f35-887e-f8903820fc7e'
const account = {
  id: accountId,
  parentId: null,
  code: 'A_1000',
  name: 'Assets',
  type: 'ASSET',
  currency: 'IRR',
  isSystem: true,
  isPostable: false,
  isActive: true,
  systemKey: 'ASSETS',
  templateVersion: 1,
  governanceVersion: 1,
} as const

describe('financial operations contracts', () => {
  it('validates governed account and bootstrap read models', () => {
    expect(ledgerAccountSummarySchema.parse(account)).toEqual(account)
    expect(
      tenantFinancialBootstrapSummarySchema.parse({
        id: 'dc1f7233-e98e-460c-bd73-730df4455eb2',
        tenantId,
        templateVersion: 1,
        accountCount: 1,
        correlationId,
        completedAt: '2026-08-03T12:00:00.000Z',
        accounts: [account],
      }).accountCount,
    ).toBe(1)
  })

  it('validates bootstrap and account-state event payloads', () => {
    expect(
      financialChartProvisionedEventPayloadSchema.parse({
        tenantId,
        templateVersion: 1,
        accountCount: 14,
      }),
    ).toBeDefined()
    expect(
      ledgerAccountStateChangedEventPayloadSchema.parse({
        ledgerAccountId: accountId,
        code: 'A_1100_CASH_CLEARING',
        fromActive: true,
        toActive: false,
        version: 2,
        reason: 'Temporarily unavailable for new postings',
      }),
    ).toBeDefined()
  })

  it('rejects unsafe account codes and incomplete governance payloads', () => {
    expect(() => ledgerAccountSummarySchema.parse({ ...account, code: 'bad code' })).toThrow()
    expect(() =>
      ledgerAccountStateChangedEventPayloadSchema.parse({
        ledgerAccountId: accountId,
        code: account.code,
        fromActive: true,
        toActive: false,
        version: 2,
        reason: '',
      }),
    ).toThrow()
  })
})
