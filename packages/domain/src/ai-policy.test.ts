import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  AiAction,
  AiHumanApproval,
  AiProposalAdmissionTrustContext,
  evaluateAiProposalAdmission,
} from './ai-policy'

const requestedAt = new Date('2026-08-01T12:00:00.000Z')
const evaluatedAt = new Date('2026-08-01T12:00:01.000Z')
const tenantId = 'tenant-a'
const requesterId = 'agent-account-1'
const evidence = {
  evidenceId: 'evidence-1',
  tenantId,
  classification: 'INTERNAL' as const,
  redactionStatus: 'REDACTED' as const,
  provenanceUri: 'evidence://logs/1',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  retainedUntil: new Date('2026-09-01T00:00:00.000Z'),
}
const base = {
  proposalId: 'proposal-1',
  tenantId,
  requestedByAccountId: requesterId,
  agentCharterVersion: 'ciso-v1',
  modelVersion: 'model-v1',
  action: AiAction.DETECT,
  policyVersion: 'ai-policy-v1',
  promptInjectionAssessment: 'PASS' as const,
  evidence: [evidence],
  requestedAt,
}
const trust: AiProposalAdmissionTrustContext = {
  evaluatedAt,
  authoritativeCharter: {
    version: 'ciso-v1',
    allowedActions: [AiAction.DETECT, AiAction.DEPLOY],
  },
}
const approval: AiHumanApproval = {
  approvalId: 'approval-1',
  proposalId: base.proposalId,
  tenantId,
  action: AiAction.DEPLOY,
  approvedByAccountId: 'human-1',
  approvedAt: new Date('2026-08-01T11:00:00.000Z'),
  expiresAt: new Date('2026-08-01T13:00:00.000Z'),
  reason: 'Reviewed isolated validation evidence',
  ticketReference: 'SEC-123',
}

describe('AI proposal admission policy', () => {
  it('admits a traceable advisory proposal without authorizing execution', () => {
    expect(evaluateAiProposalAdmission(base, trust)).toEqual({
      outcome: 'ADMIT_ADVISORY_PROPOSAL',
      policyVersion: 'ai-policy-v1',
      executionAuthorized: false,
    })
  })

  it('uses only the trusted charter as action authority', () => {
    expect(() =>
      evaluateAiProposalAdmission(
        { ...base, action: AiAction.PROPOSE_PATCH },
        {
          ...trust,
          authoritativeCharter: {
            ...trust.authoritativeCharter,
            allowedActions: [AiAction.DETECT],
          },
        },
      ),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(base, {
        ...trust,
        authoritativeCharter: { ...trust.authoritativeCharter, version: 'ciso-v2' },
      }),
    ).toThrowError(DomainError)
  })

  it('fails closed for cross-tenant, unredacted, or injection-risk evidence', () => {
    expect(() =>
      evaluateAiProposalAdmission(
        { ...base, evidence: [{ ...evidence, tenantId: 'tenant-b' }] },
        trust,
      ),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(
        {
          ...base,
          evidence: [
            {
              ...evidence,
              classification: 'PII',
              redactionStatus: 'NOT_REQUIRED',
            },
          ],
        },
        trust,
      ),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission({ ...base, promptInjectionAssessment: 'FAIL' }, trust),
    ).toThrowError(DomainError)
  })

  it('uses trusted evaluation time to reject replayed expired evidence and approval', () => {
    const replayTrust = {
      ...trust,
      evaluatedAt: new Date('2026-10-01T00:00:00.000Z'),
      verifiedApproval: approval,
    }
    expect(() =>
      evaluateAiProposalAdmission(
        { ...base, action: AiAction.DEPLOY, approvalId: approval.approvalId },
        replayTrust,
      ),
    ).toThrowError(DomainError)
  })

  it('rejects invalid request, evaluation, evidence, and approval dates', () => {
    const invalid = new Date('invalid')
    expect(() =>
      evaluateAiProposalAdmission({ ...base, requestedAt: invalid }, trust),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(base, { ...trust, evaluatedAt: invalid }),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(
        { ...base, evidence: [{ ...evidence, retainedUntil: invalid }] },
        trust,
      ),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(
        { ...base, action: AiAction.DEPLOY, approvalId: approval.approvalId },
        { ...trust, verifiedApproval: { ...approval, expiresAt: invalid } },
      ),
    ).toThrowError(DomainError)
  })

  it('rejects unverified, mismatched, and self-issued approvals', () => {
    const privileged = { ...base, action: AiAction.DEPLOY, approvalId: approval.approvalId }
    expect(() => evaluateAiProposalAdmission(privileged, trust)).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(privileged, {
        ...trust,
        verifiedApproval: { ...approval, approvalId: 'different-approval' },
      }),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiProposalAdmission(privileged, {
        ...trust,
        verifiedApproval: { ...approval, approvedByAccountId: requesterId },
      }),
    ).toThrowError(DomainError)
  })

  it('admits a verified privileged proposal but never authorizes execution', () => {
    expect(
      evaluateAiProposalAdmission(
        { ...base, action: AiAction.DEPLOY, approvalId: approval.approvalId },
        { ...trust, verifiedApproval: approval },
      ),
    ).toEqual({
      outcome: 'ADMIT_APPROVED_PROPOSAL',
      policyVersion: 'ai-policy-v1',
      executionAuthorized: false,
    })
  })
})
