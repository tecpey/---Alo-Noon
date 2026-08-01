import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { AiAction, evaluateAiProposalAdmission } from './ai-policy'

const requestedAt = new Date('2026-08-01T12:00:00.000Z')
const tenantId = 'tenant-a'
const base = {
  proposalId: 'proposal-1',
  tenantId,
  agentCharterVersion: 'ciso-v1',
  modelVersion: 'model-v1',
  allowedActions: [AiAction.DETECT, AiAction.DEPLOY],
  action: AiAction.DETECT,
  policyVersion: 'ai-policy-v1',
  promptInjectionAssessment: 'PASS' as const,
  evidence: [
    {
      evidenceId: 'evidence-1',
      tenantId,
      classification: 'INTERNAL' as const,
      redactionStatus: 'REDACTED' as const,
      provenanceUri: 'evidence://logs/1',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      retainedUntil: new Date('2026-09-01T00:00:00.000Z'),
    },
  ],
  requestedAt,
}

describe('AI proposal admission policy', () => {
  it('admits a traceable advisory proposal without authorizing execution', () => {
    expect(evaluateAiProposalAdmission(base)).toEqual({
      outcome: 'ADMIT_ADVISORY_PROPOSAL',
      policyVersion: 'ai-policy-v1',
      executionAuthorized: false,
    })
  })

  it('fails closed for cross-tenant, unredacted, or injection-risk evidence', () => {
    expect(() =>
      evaluateAiProposalAdmission({
        ...base,
        evidence: [{ ...base.evidence[0], tenantId: 'tenant-b' }],
      }),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission({
        ...base,
        evidence: [
          {
            ...base.evidence[0],
            classification: 'PII',
            redactionStatus: 'NOT_REQUIRED',
          },
        ],
      }),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission({ ...base, promptInjectionAssessment: 'FAIL' }),
    ).toThrowError(DomainError)
  })

  it('rejects privileged proposals without a live, exactly scoped human approval', () => {
    const privileged = { ...base, action: AiAction.DEPLOY }
    expect(() => evaluateAiProposalAdmission(privileged)).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission({
        ...privileged,
        approval: {
          proposalId: base.proposalId,
          tenantId,
          action: AiAction.DEPLOY,
          approvedByAccountId: 'human-1',
          approvedAt: new Date('2026-08-01T11:00:00.000Z'),
          expiresAt: new Date('2026-08-01T11:59:59.000Z'),
          reason: 'Reviewed isolated validation evidence',
          ticketReference: 'SEC-123',
        },
      }),
    ).toThrowError(DomainError)
  })

  it('admits an approved privileged proposal but never authorizes execution', () => {
    expect(
      evaluateAiProposalAdmission({
        ...base,
        action: AiAction.DEPLOY,
        approval: {
          proposalId: base.proposalId,
          tenantId,
          action: AiAction.DEPLOY,
          approvedByAccountId: 'human-1',
          approvedAt: new Date('2026-08-01T11:00:00.000Z'),
          expiresAt: new Date('2026-08-01T13:00:00.000Z'),
          reason: 'Reviewed isolated validation evidence',
          ticketReference: 'SEC-123',
        },
      }),
    ).toEqual({
      outcome: 'ADMIT_APPROVED_PROPOSAL',
      policyVersion: 'ai-policy-v1',
      executionAuthorized: false,
    })
  })
})
