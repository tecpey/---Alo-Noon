import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

export const aiAgentRoleSchema = z.enum([
  'CEO',
  'CTO',
  'CPO',
  'COO',
  'CISO',
  'CFO_FINANCE',
  'CX_CRM',
  'DATA_AI',
])

export const aiActionSchema = z.enum([
  'DETECT',
  'CORRELATE',
  'EXPLAIN',
  'PRIORITIZE',
  'DRAFT_INCIDENT',
  'PROPOSE_PATCH',
  'OPEN_DRAFT_WORK_ITEM',
  'PRODUCTION_WRITE',
  'DEPLOY',
  'READ_SECRET',
  'CHANGE_PERMISSION',
  'FINANCIAL_ACTION',
  'CONTACT_CUSTOMER',
  'CROSS_TENANT_ACCESS',
])

export const aiEvidenceReferenceSchema = z.object({
  evidenceId: uuidSchema,
  tenantId: uuidSchema,
  sourceType: z.enum([
    'LOG',
    'TRACE',
    'METRIC',
    'INCIDENT',
    'DEPLOYMENT',
    'PRODUCT_EVENT',
    'DECISION',
    'POSTMORTEM',
  ]),
  classification: z.enum(['PUBLIC', 'INTERNAL', 'TENANT_CONFIDENTIAL', 'PII']),
  redactionStatus: z.enum(['NOT_REQUIRED', 'REDACTED', 'BLOCKED']),
  provenanceUri: z.string().min(1).max(500),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  retainedUntil: isoDateTimeSchema,
})

export const aiHumanApprovalSchema = z.object({
  approvalId: uuidSchema,
  proposalId: uuidSchema,
  tenantId: uuidSchema,
  action: aiActionSchema,
  approvedByAccountId: uuidSchema,
  approvedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  reason: z.string().min(10).max(1000),
  ticketReference: z.string().min(1).max(128),
})

export const aiProposalAdmissionRequestSchema = z.object({
  proposalId: uuidSchema,
  tenantId: uuidSchema,
  requestedByAccountId: uuidSchema,
  agent: z
    .object({
      role: aiAgentRoleSchema,
      charterVersion: z.string().min(1).max(64),
      modelProvider: z.string().min(1).max(64),
      modelVersion: z.string().min(1).max(128),
    })
    .strict(),
  action: aiActionSchema,
  purpose: z.string().min(1).max(200),
  policyVersion: z.string().min(1).max(64),
  promptInjectionAssessment: z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']),
  evidence: z.array(aiEvidenceReferenceSchema).min(1),
  approvalId: uuidSchema.optional(),
  requestedAt: isoDateTimeSchema,
}).strict()

const admittedDecisionSchema = z.object({
  outcome: z.enum(['ADMIT_ADVISORY_PROPOSAL', 'ADMIT_APPROVED_PROPOSAL']),
  policyVersion: z.string().min(1).max(64),
  reasons: z.array(z.never()).default([]),
  executionAuthorized: z.literal(false),
})

const deniedDecisionSchema = z.object({
  outcome: z.literal('DENY'),
  policyVersion: z.string().min(1).max(64),
  reasons: z.array(z.string().min(1)).min(1),
  executionAuthorized: z.literal(false),
})

export const aiProposalAdmissionDecisionSchema = z.discriminatedUnion('outcome', [
  admittedDecisionSchema,
  deniedDecisionSchema,
])

export type AiProposalAdmissionRequest = z.infer<typeof aiProposalAdmissionRequestSchema>
export type AiProposalAdmissionDecision = z.infer<typeof aiProposalAdmissionDecisionSchema>
