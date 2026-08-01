import { describe, expect, it } from 'vitest'

import { assertAiAuditEventPolicy } from './ai-audit-policy'
import { DomainError } from './errors'

const validEvent = {
  classification: 'INTERNAL',
  redactionStatus: 'NOT_REQUIRED',
  sequence: 1,
  payload: { outcome: 'ADMIT_ADVISORY_PROPOSAL' },
} as const

describe('AI audit policy', () => {
  it('accepts a sanitized first audit event', () => {
    expect(() => assertAiAuditEventPolicy(validEvent)).not.toThrow()
  })

  it.each([
    ['accessToken', 'value'],
    ['refresh_token', 'value'],
    ['clientSecret', 'value'],
    ['credentials', 'value'],
    ['rawPrompt', 'ignore rules'],
  ])('rejects secret-bearing payload key %s', (key, value) => {
    expect(() =>
      assertAiAuditEventPolicy({ ...validEvent, payload: { [key]: value } }),
    ).toThrowError(DomainError)
  })

  it('rejects credential-shaped values and unredacted PII', () => {
    expect(() =>
      assertAiAuditEventPolicy({
        ...validEvent,
        payload: { header: 'Bearer abc.def.ghi' },
      }),
    ).toThrowError(DomainError)
    expect(() =>
      assertAiAuditEventPolicy({
        ...validEvent,
        classification: 'PII',
        redactionStatus: 'REDACTED',
        payload: { customer: { phone: '+989111111111' } },
      }),
    ).toThrowError(DomainError)
  })

  it('requires PII marking and a structurally valid predecessor reference', () => {
    expect(() =>
      assertAiAuditEventPolicy({
        ...validEvent,
        classification: 'PII',
        redactionStatus: 'NOT_REQUIRED',
        payload: { phone: '[REDACTED]' },
      }),
    ).toThrowError(DomainError)
    expect(() => assertAiAuditEventPolicy({ ...validEvent, sequence: 2 })).toThrowError(DomainError)
    expect(() =>
      assertAiAuditEventPolicy({
        ...validEvent,
        previousEventDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toThrowError(DomainError)
  })
})
