import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { grantRoleCommandSchema, revokeRoleCommandSchema } from '@alo-noon/contracts'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  adminResponseMeta,
  authenticatedStaff,
  errorEnvelope,
  type AdminAuthDependencies,
} from './admin-auth.js'
import { AdminAccessError, type AdminAccessService } from './admin-access.js'

/**
 * Staff access management routes.
 *
 * `admin.access.manage` is separated from the other admin permissions on
 * purpose: the ability to widen someone's access, including one's own, is the
 * one capability that should be possible to withhold from an otherwise fully
 * privileged operator. These routes are the only place it is honoured.
 */
const ACCESS_PERMISSION = ADMIN_PERMISSIONS.accessManage

// Deliberately tighter than the rest of the admin surface. Granting roles is
// the highest-consequence thing an operator can do, and nobody needs to do it
// quickly.
const ACCESS_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

export interface AdminAccessDependencies extends AdminAuthDependencies {
  service: AdminAccessService
}

export function registerAdminAccessRoutes(
  app: FastifyInstance,
  dependencies: AdminAccessDependencies,
): void {
  const now = (): Date => dependencies.now?.() ?? new Date()

  app.get('/api/v1/admin/access/roles', ACCESS_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, ACCESS_PERMISSION)
    if (!actor) return reply
    // Each role is marked with whether this caller could grant it, so the panel
    // can show the whole catalogue without offering a role the API would refuse.
    const roles = dependencies.service.listRoles({
      accountId: actor.accountId,
      permissions: actor.permissions,
    })
    return reply.send({ success: true, data: roles, meta: adminResponseMeta() })
  })

  app.get('/api/v1/admin/access/staff', ACCESS_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, ACCESS_PERMISSION)
    if (!actor) return reply
    try {
      const staff = await dependencies.service.listStaff(actor.tenantId, {
        accountId: actor.accountId,
        permissions: actor.permissions,
      })
      return reply.send({ success: true, data: staff, meta: adminResponseMeta() })
    } catch (error) {
      return accessFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/access/grants', ACCESS_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, ACCESS_PERMISSION)
    if (!actor) return reply
    const parsed = grantRoleCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('INVALID_GRANT_COMMAND', 'The command is invalid.'))
    }

    try {
      const member = await dependencies.service.grantRole(
        actor.tenantId,
        { accountId: actor.accountId, permissions: actor.permissions },
        parsed.data,
        now(),
        randomUUID(),
      )
      return reply.code(201).send({ success: true, data: member, meta: adminResponseMeta() })
    } catch (error) {
      return accessFailure(request, reply, error)
    }
  })

  app.post('/api/v1/admin/access/revocations', ACCESS_RATE_LIMIT, async (request, reply) => {
    const actor = await authenticatedStaff(request, reply, dependencies, ACCESS_PERMISSION)
    if (!actor) return reply
    const parsed = revokeRoleCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('INVALID_REVOKE_COMMAND', 'The command is invalid.'))
    }

    try {
      const member = await dependencies.service.revokeRole(
        actor.tenantId,
        { accountId: actor.accountId, permissions: actor.permissions },
        parsed.data,
        now(),
        randomUUID(),
      )
      return reply.send({ success: true, data: member, meta: adminResponseMeta() })
    } catch (error) {
      return accessFailure(request, reply, error)
    }
  })
}

const ACCESS_MESSAGES: Readonly<Record<string, string>> = {
  ACCESS_OPERATION_FORBIDDEN: 'This account may not manage staff access.',
  ROLE_UNKNOWN: 'No such role.',
  ROLE_EXCEEDS_GRANTER:
    'That role carries a permission this account does not hold, so it cannot be granted or revoked here.',
  ACCOUNT_NOT_FOUND: 'No account for that number. Ask them to sign in once first.',
  ACCOUNT_NOT_ACTIVE: 'That account is not active.',
  ACCOUNT_NOT_IN_TENANT: 'That account is not a member of this tenant.',
  GRANT_NOT_FOUND: 'No such grant.',
  CANNOT_REVOKE_SELF: 'An account cannot revoke its own access.',
  ACCESS_WRITE_CONFLICT: 'Another change landed first. Reload and try again.',
}

function accessFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AdminAccessError) {
    return reply
      .code(error.status)
      .send(errorEnvelope(error.code, ACCESS_MESSAGES[error.code] ?? 'The request was refused.'))
  }
  if (isInvalidIdentifier(error)) {
    return reply.code(404).send(errorEnvelope('GRANT_NOT_FOUND', 'No such grant.'))
  }
  request.log.error({ err: error }, 'Admin access operation failed')
  return reply
    .code(503)
    .send(errorEnvelope('ACCESS_UNAVAILABLE', 'Access management is temporarily unavailable.'))
}

function isInvalidIdentifier(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Reflect.get(error, 'code')
  return code === 'P2023' || Reflect.get(Reflect.get(error, 'meta') ?? {}, 'code') === '22P02'
}
