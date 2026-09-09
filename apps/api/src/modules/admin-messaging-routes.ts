import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  messageChannelSchema,
  previewMessageTemplateSchema,
  updateMessageTemplateSchema,
} from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import {
  AdminMessagingError,
  parseMessageTemplatePurpose,
  type AdminMessagingService,
} from './admin-messaging.js'

/**
 * Message wording, for staff.
 *
 * Channel and purpose travel in the path rather than the body so that a request
 * cannot claim to be for a different purpose than the one whose variables the
 * server validated the body against.
 */
const MESSAGING_PERMISSION = ADMIN_PERMISSIONS.notificationProviderGovern

// Preview is typed against as an operator writes, so it gets room; saving does
// not need any.
const MESSAGING_READ_LIMIT = { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }
const MESSAGING_WRITE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

export interface AdminMessagingDependencies extends AdminAuthDependencies {
  service: AdminMessagingService
}

type TemplateParams = { channel: string; purpose: string }

export function registerAdminMessagingRoutes(
  app: FastifyInstance,
  dependencies: AdminMessagingDependencies,
): void {
  const currentTime = (): Date => dependencies.now?.() ?? new Date()

  app.get<{ Params: { channel: string } }>(
    '/api/v1/admin/messaging/templates/:channel',
    MESSAGING_READ_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, MESSAGING_PERMISSION)
      if (!actor) return reply
      const channel = messageChannelSchema.safeParse(request.params.channel.toUpperCase())
      if (!channel.success) {
        return reply
          .code(404)
          .send(errorEnvelope('MESSAGE_CHANNEL_UNKNOWN', 'No such message channel.'))
      }
      try {
        const templates = await dependencies.service.list(actor.tenantId, channel.data)
        return reply.send({ success: true, data: templates, meta: adminResponseMeta() })
      } catch (error) {
        return messagingFailure(request, reply, error)
      }
    },
  )

  app.put<{ Params: TemplateParams }>(
    '/api/v1/admin/messaging/templates/:channel/:purpose',
    MESSAGING_WRITE_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, MESSAGING_PERMISSION)
      if (!actor) return reply
      const channel = messageChannelSchema.safeParse(request.params.channel.toUpperCase())
      if (!channel.success) {
        return reply
          .code(404)
          .send(errorEnvelope('MESSAGE_CHANNEL_UNKNOWN', 'No such message channel.'))
      }
      const parsed = updateMessageTemplateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_MESSAGE_TEMPLATE', 'The template is invalid.'))
      }

      try {
        const template = await dependencies.service.update(
          actor.tenantId,
          { accountId: actor.accountId },
          channel.data,
          parseMessageTemplatePurpose(request.params.purpose.toUpperCase()),
          parsed.data,
          currentTime(),
          randomUUID(),
        )
        return reply.send({ success: true, data: template, meta: adminResponseMeta() })
      } catch (error) {
        return messagingFailure(request, reply, error)
      }
    },
  )

  /**
   * Rendered by the same function that renders the real message, so what the
   * operator is shown before saving is what a customer will receive. A preview
   * computed a second way would eventually disagree with what is sent, and the
   * disagreement would surface on a customer's phone.
   */
  app.post<{ Params: TemplateParams }>(
    '/api/v1/admin/messaging/templates/:channel/:purpose/preview',
    MESSAGING_READ_LIMIT,
    async (request, reply) => {
      const actor = await authenticatedStaff(request, reply, dependencies, MESSAGING_PERMISSION)
      if (!actor) return reply
      const parsed = previewMessageTemplateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply
          .code(400)
          .send(errorEnvelope('INVALID_MESSAGE_TEMPLATE', 'The template is invalid.'))
      }
      try {
        const purpose = parseMessageTemplatePurpose(request.params.purpose.toUpperCase())
        return reply.send({
          success: true,
          data: dependencies.service.preview(purpose, parsed.data.body),
          meta: adminResponseMeta(),
        })
      } catch (error) {
        return messagingFailure(request, reply, error)
      }
    },
  )
}

const MESSAGING_MESSAGES: Readonly<Record<string, string>> = {
  MESSAGING_OPERATION_FORBIDDEN: 'This account may not edit message templates.',
  MESSAGE_TEMPLATE_PURPOSE_UNKNOWN: 'No such message.',
  MESSAGE_TEMPLATE_INVALID: 'The message text is not valid for this kind of message.',
  MESSAGE_TEMPLATE_OTP_REQUIRED:
    'The sign-in code message cannot be switched off — nobody could sign in afterwards.',
  MESSAGE_TEMPLATE_WRITE_CONFLICT: 'Someone else saved this message first. Reload and try again.',
}

function messagingFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AdminMessagingError) {
    return reply.code(error.status).send({
      success: false,
      error: {
        code: error.code,
        message: MESSAGING_MESSAGES[error.code] ?? 'The request was refused.',
        // Which variable was wrong, so the panel can point at it instead of
        // making the operator guess which word the server objected to.
        ...(error.problems.length > 0 && { details: error.problems }),
      },
      meta: adminResponseMeta(),
    })
  }
  request.log.error({ err: error }, 'Message template operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('MESSAGING_UNAVAILABLE', 'Message templates are unavailable.'))
}
