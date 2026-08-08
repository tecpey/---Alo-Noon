import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import type {
  MessageChannel,
  MessageTemplateList,
  MessageTemplatePreview,
  MessageTemplatePurpose,
  MessageTemplateView,
  UpdateMessageTemplateCommand,
} from '@alo-noon/contracts'
import {
  ADMIN_PERMISSIONS,
  MESSAGE_TEMPLATE_DEFINITIONS,
  isMessageTemplatePurpose,
  messageTemplateDefinition,
  previewMessageTemplate,
  smsSegments,
  validateMessageTemplateBody,
  type MessageTemplateProblem,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'

/**
 * Message wording, authored by the operator.
 *
 * Every message the system can send appears here whether or not the tenant has
 * touched it, because a message going out in its shipped wording still needs to
 * be visible to whoever is answering the phone about it. A tenant with no rows
 * at all is not a tenant that sends nothing — it is a tenant sending the
 * defaults.
 *
 * The rule that makes this safe to expose is in the domain package: a body may
 * only name variables its purpose can supply. Without it an operator could put
 * `{amount}` in the one-time-code message and every customer signing in would
 * receive those eight characters verbatim.
 */
export interface MessagingActor {
  accountId: string
}

export class AdminMessagingError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly problems: readonly MessageTemplateProblem[] = [],
  ) {
    super(code)
    this.name = 'AdminMessagingError'
  }
}

/** The effective wording for one message, for whoever is about to send it. */
export interface ResolvedMessageTemplate {
  readonly body: string
  readonly enabled: boolean
  readonly version: number
  readonly customized: boolean
}

export interface AdminMessagingService {
  list(tenantId: string, channel: MessageChannel): Promise<MessageTemplateList>
  update(
    tenantId: string,
    actor: MessagingActor,
    channel: MessageChannel,
    purpose: MessageTemplatePurpose,
    command: UpdateMessageTemplateCommand,
    now: Date,
    correlationId: string,
  ): Promise<MessageTemplateView>
  preview(purpose: MessageTemplatePurpose, body: string): MessageTemplatePreview
  resolve(
    tenantId: string,
    channel: MessageChannel,
    purpose: MessageTemplatePurpose,
  ): Promise<ResolvedMessageTemplate>
}

interface TemplateRow {
  body: string
  enabled: boolean
  version: number
  updatedById: string | null
  updatedAt: Date
}

export function createPrismaAdminMessagingService(prisma: PrismaClient): AdminMessagingService {
  return {
    async list(tenantId, channel) {
      const rows = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.messageTemplate.findMany({ where: { tenantId, channel } }),
      )
      const byPurpose = new Map(rows.map((row) => [row.purpose as MessageTemplatePurpose, row]))
      return {
        templates: MESSAGE_TEMPLATE_DEFINITIONS.map((definition) =>
          templateView(channel, definition.purpose, byPurpose.get(definition.purpose) ?? null),
        ),
      }
    },

    async update(tenantId, actor, channel, purpose, command, now, correlationId) {
      const body = command.body.trim()
      const problems = validateMessageTemplateBody(purpose, body)
      if (problems.length > 0) {
        throw new AdminMessagingError('MESSAGE_TEMPLATE_INVALID', 422, problems)
      }
      // Refused here rather than left to the database guard so the operator gets
      // a sentence instead of a constraint name — but the guard stays, because
      // this service is not the only thing that can write the row.
      if (purpose === 'AUTH_OTP' && !command.enabled) {
        throw new AdminMessagingError('MESSAGE_TEMPLATE_OTP_REQUIRED', 422)
      }

      const row = await writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const existing = await transaction.messageTemplate.findUnique({
          where: { tenantId_channel_purpose: { tenantId, channel, purpose } },
        })
        const saved = existing
          ? await transaction.messageTemplate.update({
              where: { id: existing.id },
              data: {
                body,
                enabled: command.enabled,
                // The guard requires a strict increase: an audit entry naming
                // version 4 has to mean one thing forever.
                version: existing.version + 1,
                updatedById: actor.accountId,
              },
            })
          : await transaction.messageTemplate.create({
              data: {
                tenantId,
                channel,
                purpose,
                body,
                enabled: command.enabled,
                updatedById: actor.accountId,
              },
            })

        await transaction.auditEvent.create({
          data: {
            tenantId,
            actorType: 'STAFF',
            actorId: actor.accountId,
            action: 'messaging.template.updated',
            entityType: 'MessageTemplate',
            entityId: saved.id,
            summary: `${channel} ${purpose} template saved at version ${saved.version}`,
            correlationId,
            occurredAt: now,
          },
        })
        await transaction.domainEventOutbox.create({
          data: {
            tenantId,
            eventId: randomUUID(),
            name: 'messaging.template.updated',
            aggregateType: 'MessageTemplate',
            aggregateId: saved.id,
            actorType: 'STAFF',
            actorId: actor.accountId,
            correlationId,
            // Wording the business chose for its own messages. It describes what
            // the tenant says, not who it was said to, so no consent applies.
            consentBasis: 'NOT_REQUIRED',
            payload: {
              channel,
              purpose,
              version: saved.version,
              enabled: saved.enabled,
              // The previous body, so a message a customer disputes can be read
              // back to the wording that was live when it was sent.
              previousBody: existing?.body ?? null,
              body: saved.body,
            },
            occurredAt: now,
          },
        })
        return saved
      })

      return templateView(channel, purpose, row)
    },

    preview(purpose, body) {
      const rendered = previewMessageTemplate(purpose, body)
      return { preview: rendered, segments: smsSegments(rendered) }
    },

    async resolve(tenantId, channel, purpose) {
      const row = await readTransaction(prisma, tenantId, (transaction) =>
        transaction.messageTemplate.findUnique({
          where: { tenantId_channel_purpose: { tenantId, channel, purpose } },
        }),
      )
      const definition = messageTemplateDefinition(purpose)
      return row
        ? {
            body: row.body,
            enabled: row.enabled,
            version: row.version,
            customized: true,
          }
        : // A tenant that has never opened the panel still sends something
          // sensible, rather than nothing or an empty message.
          { body: definition.defaultBody, enabled: true, version: 0, customized: false }
    },
  }
}

export function parseMessageTemplatePurpose(value: string): MessageTemplatePurpose {
  if (!isMessageTemplatePurpose(value)) {
    throw new AdminMessagingError('MESSAGE_TEMPLATE_PURPOSE_UNKNOWN', 404)
  }
  return value
}

function templateView(
  channel: MessageChannel,
  purpose: MessageTemplatePurpose,
  row: TemplateRow | null,
): MessageTemplateView {
  const definition = messageTemplateDefinition(purpose)
  const body = row?.body ?? definition.defaultBody
  const preview = previewMessageTemplate(purpose, body)
  return {
    channel,
    purpose,
    labelFa: definition.labelFa,
    descriptionFa: definition.descriptionFa,
    body,
    defaultBody: definition.defaultBody,
    customized: row !== null,
    enabled: row?.enabled ?? true,
    version: row?.version ?? 0,
    variables: definition.variables.map((variable) => ({
      name: variable.name,
      required: variable.required,
      labelFa: variable.labelFa,
      example: variable.example,
    })),
    preview,
    segments: smsSegments(preview),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedById: row?.updatedById ?? null,
  }
}

async function readTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * A template write, with the acting account's permission re-checked against live
 * grant rows inside the same transaction as the change it authorizes.
 */
async function writeTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  actor: MessagingActor,
  now: Date,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        const permitted = await holdsPermissionInTransaction(
          transaction,
          tenantId,
          actor.accountId,
          ADMIN_PERMISSIONS.notificationProviderGovern,
          now,
        )
        if (!permitted) throw new AdminMessagingError('MESSAGING_OPERATION_FORBIDDEN', 403)
        return operation(transaction)
      },
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object') {
      // Two operators saved the same template at once. Neither is an outage.
      const code = Reflect.get(error, 'code')
      if (code === 'P2002' || code === 'P2034') {
        throw new AdminMessagingError('MESSAGE_TEMPLATE_WRITE_CONFLICT', 409)
      }
    }
    throw error
  }
}
