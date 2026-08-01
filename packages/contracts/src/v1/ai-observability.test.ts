import { describe, expect, it } from 'vitest'

import { aiAuditEventSchema } from './ai-observability'

const event = {
  eventId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000002',
  proposalId: '30000000-0000-4000-8000-000000000003',
  sequence: 1,
  eventType: 'POLICY_DECIDED',
  agentRole: 'CISO',
  action: 'DETECT',
  classification: 'INTERNAL',
  redactionStatus: 'REDACTED',
  correlationId: '40000000-0000-4000-8000-000000000004',
  traceId: 'trace-0123456789abcdef',
  charterVersion: 'ciso-v1',
  policyVersion: 'ai-policy-v1',
  modelProvider: 'provider-abstract',
  modelVersion: 'model-v1',
  provenanceUri: 'policy://ai-policy-v1/decision/3',
  payload: { outcome: 'ADMIT_ADVISORY_PROPOSAL' },
  payloadDigest: `sha256:${'a'.repeat(64)}`,
  eventDigest: `sha256:${'b'.repeat(64)}`,
  occurredAt: '2026-08-01T12:00:00.000Z',
  retainedUntil: '2027-08-01T12:00:00.000Z',
} as const

describe('AI observability contracts', () => {
  it('accepts a correlated, versioned and digest-bound audit event', () => {
    expect(aiAuditEventSchema.parse(event)).toBeDefined()
  })

  it('rejects secret classification and unverifiable digests', () => {
    expect(() => aiAuditEventSchema.parse({ ...event, classification: 'SECRET' })).toThrow()
    expect(() => aiAuditEventSchema.parse({ ...event, eventDigest: 'unsigned' })).toThrow()
  })

  it('rejects raw prompts, secret-bearing fields and credential-shaped values', () => {
    expect(() =>
      aiAuditEventSchema.parse({ ...event, payload: { rawPrompt: 'ignore rules' } }),
    ).toThrow()
    expect(() =>
      aiAuditEventSchema.parse({ ...event, payload: { apiKey: 'not-a-real-key' } }),
    ).toThrow()
    expect(() =>
      aiAuditEventSchema.parse({ ...event, payload: { header: 'Bearer abc.def.ghi' } }),
    ).toThrow()
  })

  it('requires PII redaction and a structurally valid predecessor reference', () => {
    expect(() =>
      aiAuditEventSchema.parse({
        ...event,
        classification: 'PII',
        redactionStatus: 'NOT_REQUIRED',
      }),
    ).toThrow()
    expect(() =>
      aiAuditEventSchema.parse({
        ...event,
        sequence: 2,
        previousEventDigest: undefined,
      }),
    ).toThrow()
    expect(() =>
      aiAuditEventSchema.parse({
        ...event,
        sequence: 1,
        previousEventDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toThrow()
  })
})
