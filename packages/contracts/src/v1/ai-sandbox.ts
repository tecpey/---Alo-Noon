import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'))

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
    changedPaths: z.array(repositoryPathSchema).min(1).max(200),
    requestedAt: isoDateTimeSchema,
  })
  .strict()

export const aiSandboxPatchValidationDecisionSchema = z
  .object({
    outcome: z.enum(['VALIDATED_PATCH_PROPOSAL', 'DENY']),
    validationId: uuidSchema,
    policyVersion: z.string().min(1).max(64),
    attestationDigest: sha256Schema.optional(),
    reasons: z.array(z.string().min(1)),
    executionAuthorized: z.literal(false),
    deploymentAuthorized: z.literal(false),
  })
  .strict()

export type AiSandboxPatchValidationRequest = z.infer<
  typeof aiSandboxPatchValidationRequestSchema
>
export type AiSandboxPatchValidationDecision = z.infer<
  typeof aiSandboxPatchValidationDecisionSchema
>
