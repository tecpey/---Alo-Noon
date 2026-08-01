import { z } from 'zod'

import { aiActionSchema, aiAgentRoleSchema } from './ai-control-plane'
import { isoDateTimeSchema, uuidSchema } from './common'

export const aiDataClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'TENANT_CONFIDENTIAL',
  'PII',
  'SECRET',
])

export const aiAuditEventTypeSchema = z.enum([
  'REQUEST_RECEIVED',
  'EVIDENCE_ACCESSED',
  'PROMPT_INJECTION_ASSESSED',
  'POLICY_DECIDED',
  'TOOL_CALL_PROPOSED',
  'TOOL_CALL_RESULT_RECORDED',
  'HUMAN_APPROVAL_RECORDED',
  'PROPOSAL_EMITTED',
])

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const aiAuditEventSchema = z.object({
  eventId: uuidSchema,
  tenantId: uuidSchema,
  proposalId: uuidSchema,
  sequence: z.number().int().positive(),
  eventType: aiAuditEventTypeSchema,
  agentRole: aiAgentRoleSchema,
  action: aiActionSchema,
  classification: aiDataClassificationSchema.exclude(['SECRET']),
  redactionStatus: z.enum(['NOT_REQUIRED', 'REDACTED']),
  correlationId: uuidSchema,
  traceId: z.string().min(16).max(64),
  actorAccountId: uuidSchema.optional(),
  charterVersion: z.string().min(1).max(64),
  policyVersion: z.string().min(1).max(64),
  modelProvider: z.string().min(1).max(64),
  modelVersion: z.string().min(1).max(128),
  provenanceUri: z.string().min(1).max(500),
  payload: z.record(z.unknown()),
  payloadDigest: sha256Schema,
  previousEventDigest: sha256Schema.optional(),
  eventDigest: sha256Schema,
  occurredAt: isoDateTimeSchema,
  retainedUntil: isoDateTimeSchema,
})

export type AiAuditEvent = z.infer<typeof aiAuditEventSchema>
export type AiAuditEventType = z.infer<typeof aiAuditEventTypeSchema>
export type AiDataClassification = z.infer<typeof aiDataClassificationSchema>
