import { describe, expect, it } from 'vitest'

import { aiProposalAdmissionRequestSchema } from './ai-control-plane'

const request = {
  proposalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000002',
  agent: {
    role: 'CISO',
    charterVersion: 'ciso-v1',
    modelProvider: 'provider-abstract',
    modelVersion: 'model-v1',
    allowedActions: ['DETECT', 'EXPLAIN'],
  },
  action: 'DETECT',
  purpose: 'Detect anomalous authorization patterns',
  policyVersion: 'ai-policy-v1',
  promptInjectionAssessment: 'PASS',
  evidence: [
    {
      evidenceId: '30000000-0000-4000-8000-000000000003',
      tenantId: '20000000-0000-4000-8000-000000000002',
      sourceType: 'LOG',
      classification: 'INTERNAL',
      redactionStatus: 'REDACTED',
      provenanceUri: 'evidence://logs/authorization/3',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      retainedUntil: '2026-09-01T00:00:00.000Z',
    },
  ],
  requestedAt: '2026-08-01T12:00:00.000Z',
} as const

describe('AI control-plane contracts', () => {
  it('accepts a traceable tenant-scoped advisory proposal', () => {
    expect(aiProposalAdmissionRequestSchema.parse(request)).toBeDefined()
  })

  it('rejects missing evidence and unverifiable provenance digests', () => {
    expect(() => aiProposalAdmissionRequestSchema.parse({ ...request, evidence: [] })).toThrow()
    expect(() =>
      aiProposalAdmissionRequestSchema.parse({
        ...request,
        evidence: [{ ...request.evidence[0], contentDigest: 'unverified' }],
      }),
    ).toThrow()
  })
})
