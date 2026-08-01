import { describe, expect, it } from 'vitest'

import { aiSandboxPatchValidationRequestSchema } from './ai-sandbox'

const request = {
  validationId: '10000000-0000-4000-8000-000000000001',
  proposalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '30000000-0000-4000-8000-000000000003',
  policyVersion: 'sandbox-policy-v1',
  sandboxProfileVersion: 'isolated-runner-v1',
  baseCommitSha: 'a'.repeat(40),
  patchArtifactUri: 'artifact://patches/1',
  patchDigest: `sha256:${'b'.repeat(64)}`,
  changedPaths: ['packages/domain/src/order.ts'],
  requestedAt: '2026-08-01T14:00:00.000Z',
}

describe('AI sandbox patch validation contract', () => {
  it('accepts only a patch proposal with verifiable references', () => {
    expect(aiSandboxPatchValidationRequestSchema.parse(request)).toBeDefined()
  })

  it.each(['../secret', '/etc/passwd', 'packages/../.env'])(
    'rejects unsafe repository path %s',
    (path) => {
      expect(() =>
        aiSandboxPatchValidationRequestSchema.parse({ ...request, changedPaths: [path] }),
      ).toThrow()
    },
  )

  it('rejects agent-asserted runner authority and execution claims', () => {
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
})
