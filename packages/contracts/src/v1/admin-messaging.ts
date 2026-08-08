import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

/**
 * Message template authoring transport.
 *
 * The panel needs two things this shape provides. First, a *complete* list: an
 * operator should see every message the system can send, whether or not their
 * tenant has customised it, so a message going out in its shipped wording is
 * visible rather than absent. That is why a listed template carries both the
 * effective body and whether it is the tenant's own.
 *
 * Second, the variables each purpose allows, sent along with the template rather
 * than duplicated in the web app. A panel that hard-coded the variable list
 * would drift from the list the API enforces, and the operator would find out by
 * having a save rejected for naming a variable the panel had just offered them.
 */
export const messageChannelSchema = z.enum(['SMS'])

export const messageTemplatePurposeSchema = z.enum([
  'AUTH_OTP',
  'ORDER_ACCEPTED',
  'ORDER_REJECTED',
  'ORDER_READY',
  'ORDER_OUT_FOR_DELIVERY',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED',
])

export const messageTemplateVariableSchema = z.object({
  name: z.string().min(1).max(32),
  required: z.boolean(),
  labelFa: z.string().min(1).max(64),
  example: z.string().min(1).max(64),
})

export const messageTemplateSchema = z.object({
  channel: messageChannelSchema,
  purpose: messageTemplatePurposeSchema,
  labelFa: z.string().min(1).max(64),
  descriptionFa: z.string().min(1).max(240),
  /** What will actually be sent: the tenant's body, or the shipped default. */
  body: z.string().min(1).max(480),
  /** The shipped wording, so the panel can offer "restore the default". */
  defaultBody: z.string().min(1).max(480),
  /** False when the tenant has never saved this one and is using the default. */
  customized: z.boolean(),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  variables: z.array(messageTemplateVariableSchema),
  /** The body with every variable filled by its example, exactly as it will render. */
  preview: z.string().min(1).max(600),
  /**
   * Billable parts for the preview. Persian is UCS-2, so 70 characters is one
   * message and 71 is two — a number worth putting in front of whoever is
   * typing, since they are choosing the tenant's SMS bill.
   */
  segments: z.number().int().nonnegative(),
  updatedAt: isoDateTimeSchema.nullable(),
  updatedById: uuidSchema.nullable(),
})

export const messageTemplateListSchema = z.object({
  templates: z.array(messageTemplateSchema),
})

/**
 * The body is the only thing an edit may carry besides the switch. Channel and
 * purpose identify which template is being written and travel in the path, so a
 * body cannot arrive claiming to be for a different purpose than the one whose
 * variables were validated.
 */
export const updateMessageTemplateSchema = z
  .object({
    body: z.string().min(1).max(480),
    enabled: z.boolean(),
  })
  .strict()

export const previewMessageTemplateSchema = z
  .object({
    body: z.string().min(1).max(480),
  })
  .strict()

export const messageTemplatePreviewSchema = z.object({
  preview: z.string().max(600),
  segments: z.number().int().nonnegative(),
})

export type MessageChannel = z.infer<typeof messageChannelSchema>
export type MessageTemplatePurpose = z.infer<typeof messageTemplatePurposeSchema>
export type MessageTemplateVariableView = z.infer<typeof messageTemplateVariableSchema>
export type MessageTemplateView = z.infer<typeof messageTemplateSchema>
export type MessageTemplateList = z.infer<typeof messageTemplateListSchema>
export type UpdateMessageTemplateCommand = z.infer<typeof updateMessageTemplateSchema>
export type PreviewMessageTemplateCommand = z.infer<typeof previewMessageTemplateSchema>
export type MessageTemplatePreview = z.infer<typeof messageTemplatePreviewSchema>
