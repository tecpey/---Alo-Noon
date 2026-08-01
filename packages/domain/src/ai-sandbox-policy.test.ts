import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  evaluateAiSandboxPatchValidation,
  type AiSandboxPatchValidationTrustContext,
} from './ai-sandbox-policy'

const request = {
  validationId: 'validation-1',
  proposalId: 'proposal-1',
  tenantId: 'tenant-a',
  policyVersion: 'sandbox-policy-v1',
  sandboxProfileVersion: 'isolated-runner-v1',
  baseCommitSha: 'a'.repeat(40),
  patchArtifactUri: 'artifact://patches/1',
  patchDigest: `sha256:${'b'.repeat(64)}`,
  changedPaths: ['packages/domain/src/order.ts'],
  requestedAt: new Date('2026-08-01T14:00:00.000Z'),
}
const pass = (check: string) => ({
  check,
  outcome: 'PASS' as const,
  evidenceDigest: `sha256:${'c'.repeat(64)}`,
})
const trust: AiSandboxPatchValidationTrustContext = {
  evaluatedAt: new Date('2026-08-01T14:05:00.000Z'),
  attestation: {
    validationId: request.validationId,
    proposalId: request.proposalId,
    tenantId: request.tenantId,
    policyVersion: request.policyVersion,
    sandboxProfileVersion: request.sandboxProfileVersion,
    baseCommitSha: request.baseCommitSha,
    patchDigest: request.patchDigest,
    attestationDigest: `sha256:${'d'.repeat(64)}`,
    completedAt: new Date('2026-08-01T14:04:00.000Z'),
    networkAccess: false,
    secretMounts: false,
    productionCredentials: false,
    productionWriteAccess: false,
    checks: [pass('format'), pass('lint'), pass('typecheck'), pass('test'), pass('build')],
  },
  policy: {
    requiredChecks: ['format', 'lint', 'typecheck', 'test', 'build'],
    allowedPathPrefixes: ['packages'],
    deniedPathPrefixes: ['.github', 'infra/production'],
  },
}

describe('AI sandbox patch validation policy', () => {
  it('validates a trusted isolated result without authorizing execution or deployment', () => {
    expect(evaluateAiSandboxPatchValidation(request, trust)).toEqual({
      outcome: 'VALIDATED_PATCH_PROPOSAL',
      validationId: request.validationId,
      policyVersion: request.policyVersion,
      attestationDigest: trust.attestation.attestationDigest,
      executionAuthorized: false,
      deploymentAuthorized: false,
    })
  })

  it('rejects mismatched tenant, proposal, patch and base attestations', () => {
    for (const attestation of [
      { ...trust.attestation, tenantId: 'tenant-b' },
      { ...trust.attestation, proposalId: 'forged' },
      { ...trust.attestation, patchDigest: `sha256:${'e'.repeat(64)}` },
      { ...trust.attestation, baseCommitSha: 'f'.repeat(40) },
    ]) {
      expect(() =>
        evaluateAiSandboxPatchValidation(request, { ...trust, attestation }),
      ).toThrowError(DomainError)
    }
  })

  it('rejects missing, failed, or unverifiable trusted checks', () => {
    expect(() =>
      evaluateAiSandboxPatchValidation(request, {
        ...trust,
        attestation: { ...trust.attestation, checks: trust.attestation.checks.slice(0, 4) },
      }),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiSandboxPatchValidation(request, {
        ...trust,
        attestation: {
          ...trust.attestation,
          checks: [{ check: 'test', outcome: 'FAIL', evidenceDigest: 'unverified' }],
        },
      }),
    ).toThrowError(DomainError)
  })

  it('rejects traversal, paths outside policy, and explicitly denied paths', () => {
    for (const changedPaths of [['../secret'], ['apps/api/src/main.ts'], ['packages/../.env']]) {
      expect(() =>
        evaluateAiSandboxPatchValidation({ ...request, changedPaths }, trust),
      ).toThrowError(DomainError)
    }
    expect(() =>
      evaluateAiSandboxPatchValidation(
        { ...request, changedPaths: ['.github/workflows/deploy.yml'] },
        {
          ...trust,
          policy: { ...trust.policy, allowedPathPrefixes: ['.github', 'packages'] },
        },
      ),
    ).toThrowError(DomainError)
  })

  it('rejects replayed timestamps and altered runner capability claims at runtime', () => {
    expect(() =>
      evaluateAiSandboxPatchValidation(
        { ...request, requestedAt: new Date('2026-08-01T15:00:00.000Z') },
        trust,
      ),
    ).toThrowError(DomainError)
    expect(() =>
      evaluateAiSandboxPatchValidation(request, {
        ...trust,
        attestation: {
          ...trust.attestation,
          networkAccess: true,
        } as unknown as AiSandboxPatchValidationTrustContext['attestation'],
      }),
    ).toThrowError(DomainError)
  })
})
