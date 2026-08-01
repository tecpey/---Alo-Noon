import { describe, expect, it } from 'vitest'

import {
  aiSandboxPatchValidationDecisionSchema,
  aiSandboxPatchValidationRequestSchema,
} from './ai-sandbox'

const request = {
  validationId: '10000000-0000-4000-8000-000000000001',
  proposalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '30000000-0000-4000-8000-000000000003',
  policyVersion: 'sandbox-policy-v1',
  sandboxProfileVersion: 'isolated-runner-v1',
  baseCommitSha: 'a'.repeat(40),
  patchArtifactUri: 'artifact://patches/1',
  patchDigest: `sha256:${'b'.repeat(64)}`,
  requestedAt: '2026-08-01T14:00:00.000Z',
}

describe('AI sandbox patch validation contract', () => {
  it('accepts only a patch proposal with verifiable references', () => {
    expect(aiSandboxPatchValidationRequestSchema.parse(request)).toBeDefined()
  })

  it('rejects agent-asserted changed paths, runner authority, and execution claims', () => {
    expect(() =>
      aiSandboxPatchValidationRequestSchema.parse({
        ...request,
        changedPaths: ['packages/domain/src/order.ts'],
      }),
    ).toThrow()
    expect(() =>
      aiSandboxPatchValidationRequestSchema.parse({
        ...request,
        checks: [{ check: 'test', outcome: 'PASS' }],
      }),
    ).toThrow()
    expect(() =>
      aiSandboxPatchValidationRequestSchema.parse({
        ...request,
        executionAuthorized: true,
      }),
    ).toThrow()
  })

  it('requires a trusted attestation digest for validated decisions', () => {
    const decision = {
      outcome: 'VALIDATED_PATCH_PROPOSAL',
      validationId: request.validationId,
      policyVersion: request.policyVersion,
      reasons: [],
      executionAuthorized: false,
      deploymentAuthorized: false,
    }

    expect(() => aiSandboxPatchValidationDecisionSchema.parse(decision)).toThrow()
    expect(
      aiSandboxPatchValidationDecisionSchema.parse({
        ...decision,
        attestationDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).toBeDefined()
  })

  it('requires at least one reason for denied decisions', () => {
    expect(() =>
      aiSandboxPatchValidationDecisionSchema.parse({
        outcome: 'DENY',
        validationId: request.validationId,
        policyVersion: request.policyVersion,
        reasons: [],
        executionAuthorized: false,
        deploymentAuthorized: false,
      }),
    ).toThrow()
  })
})
