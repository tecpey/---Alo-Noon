import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)

export const aiSandboxPatchValidationRequestSchema = z
  .object({
    validationId: uuidSchema,
    proposalId: uuidSchema,
    tenantId: uuidSchema,
    policyVersion: z.string().min(1).max(64),
    sandboxProfileVersion: z.string().min(1).max(64),
    baseCommitSha: gitShaSchema,
    patchArtifactUri: z.string().min(1).max(500),
    patchDigest: sha256Schema,
    requestedAt: isoDateTimeSchema,
  })
  .strict()

const decisionBaseSchema = z.object({
  validationId: uuidSchema,
  policyVersion: z.string().min(1).max(64),
  executionAuthorized: z.literal(false),
  deploymentAuthorized: z.literal(false),
})

export const aiSandboxPatchValidationDecisionSchema = z.discriminatedUnion('outcome', [
  decisionBaseSchema
    .extend({
      outcome: z.literal('VALIDATED_PATCH_PROPOSAL'),
      attestationDigest: sha256Schema,
      reasons: z.array(z.string().min(1)).length(0),
    })
    .strict(),
  decisionBaseSchema
    .extend({
      outcome: z.literal('DENY'),
      reasons: z.array(z.string().min(1)).min(1),
    })
    .strict(),
])

export type AiSandboxPatchValidationRequest = z.infer<typeof aiSandboxPatchValidationRequestSchema>
export type AiSandboxPatchValidationDecision = z.infer<
  typeof aiSandboxPatchValidationDecisionSchema
>
