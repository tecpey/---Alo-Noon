import { randomUUID } from 'node:crypto'

import type { FastifyReply, FastifyRequest } from 'fastify'

import type { ErrorEnvelope, ResponseMeta } from '@alo-noon/contracts'

import { authenticateRequest, authorizeGrants, type AuthDependencies } from './auth.js'

/**
 * The shared front door for every `/api/v1/admin` route.
 *
 * Authorization is enforced twice across the admin surface: cheaply here, from
 * the session's grants, so an unprivileged caller is turned away before touching
 * any state; and again inside whatever write transaction follows, against live
 * grant rows. The session's copy of a grant can be stale — revoked a minute ago
 * and still present in the session — while the in-transaction check cannot.
 * Read-only routes have only this check, which is why it is not a formality.
 */
export interface AdminActor {
  tenantId: string
  accountId: string
  /** Every permission the session carries, used to refuse privilege escalation. */
  permissions: readonly string[]
}

export interface AdminAuthDependencies {
  auth: AuthDependencies
  now?: () => Date
}

/**
 * Resolves the acting staff account, or answers the request and returns null.
 * Callers must stop as soon as this returns null: the reply is already sent.
 *
 * Named to match `authenticatedCustomer`, and allow-listed by the same lint
 * rule, so every admin handler still derives tenant identity from the session
 * rather than from anything the client sent.
 */
export async function authenticatedStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminAuthDependencies,
  permission: string,
): Promise<AdminActor | null> {
  reply.header('Cache-Control', 'no-store')
  const session = await authenticateRequest(request, dependencies.auth)
  if (!session) {
    await reply
      .code(401)
      .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid staff session is required.'))
    return null
  }
  const now = dependencies.now?.() ?? new Date()
  // Admin capabilities are tenant-wide, so only a GLOBAL grant qualifies; a
  // city- or branch-scoped operator cannot reach them.
  if (!authorizeGrants(session.grants, permission, {}, now)) {
    await reply
      .code(403)
      .send(
        errorEnvelope(
          'ADMIN_PERMISSION_DENIED',
          'This account does not hold the permission this operation requires.',
        ),
      )
    return null
  }
  return {
    tenantId: session.tenantId,
    accountId: session.accountId,
    permissions: activeGlobalPermissions(session.grants, now),
  }
}

/**
 * Permissions from unexpired, GLOBAL-scoped grants only — the same set
 * `authorizeGrants` would accept one permission at a time. Narrower grants are
 * excluded because no admin route honours them, so including them here would
 * make an operator look more privileged than any route will treat them.
 */
function activeGlobalPermissions(
  grants: ReadonlyArray<{
    permissions: string[]
    scopeType: string
    scopeId: string | null
    expiresAt: string | null
  }>,
  now: Date,
): readonly string[] {
  const permissions = new Set<string>()
  for (const grant of grants) {
    if (grant.scopeType !== 'GLOBAL' || grant.scopeId !== null) continue
    if (grant.expiresAt && new Date(grant.expiresAt) <= now) continue
    for (const permission of grant.permissions) permissions.add(permission)
  }
  return [...permissions]
}

export function adminResponseMeta(): ResponseMeta {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}

export function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { success: false, error: { code, message }, meta: adminResponseMeta() }
}
