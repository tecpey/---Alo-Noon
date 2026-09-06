import { randomUUID } from 'node:crypto'

import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Prisma } from '@alo-noon/database'
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

/** An actor acting for one or more branches, and never outside them. */
export interface BranchActor extends AdminActor {
  /** Always non-empty: a session with no branch is turned away, not passed on. */
  branchIds: readonly string[]
}

/**
 * Resolves a bakery partner's staff session, or answers the request and returns
 * null. Callers must stop as soon as this returns null: the reply is sent.
 *
 * Deliberately not `authenticatedStaff` with a flag. That function's contract is
 * "holds this permission tenant-wide", and the branch surface's contract is
 * "holds it at these branches and nowhere else" — the same function answering
 * both would be one `if` away from serving a partner the tenant.
 *
 * A tenant-wide operator reaching this surface is refused rather than served
 * everything: the platform's own staff have their own panel, and a GLOBAL grant
 * arriving here means somebody opened the wrong door, not that they should be
 * shown every branch in the city at a counter.
 */
export async function authenticatedBranchStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminAuthDependencies,
  permission: string,
): Promise<BranchActor | null> {
  reply.header('Cache-Control', 'no-store')
  const session = await authenticateRequest(request, dependencies.auth)
  if (!session) {
    await reply
      .code(401)
      .send(errorEnvelope('SESSION_UNAUTHORIZED', 'A valid staff session is required.'))
    return null
  }
  const now = dependencies.now?.() ?? new Date()
  const branchIds = branchScopeFromGrants(session.grants, permission, now)
  if (branchIds === null || branchIds.length === 0) {
    await reply
      .code(403)
      .send(
        errorEnvelope(
          'BRANCH_ACCESS_DENIED',
          'This account does not operate a bakery branch in this tenant.',
        ),
      )
    return null
  }
  return {
    tenantId: session.tenantId,
    accountId: session.accountId,
    permissions: activeGlobalPermissions(session.grants, now),
    branchIds,
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

/**
 * Re-checks a permission inside a write transaction, against live grant rows.
 *
 * This is the authoritative half of the two-step check `authenticatedStaff`
 * describes. A session carries a snapshot of its grants taken at sign-in, so a
 * revocation a minute ago is invisible to it; the rows this reads are current,
 * and reading them inside the same transaction as the write means a revocation
 * cannot slip between the check and the change it guards.
 *
 * Returns whether the account still holds the permission rather than throwing,
 * because each module raises its own error type and status.
 */
export async function holdsPermissionInTransaction(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  permission: string,
  now: Date,
  /**
   * When given, a `BAKERY_BRANCH` grant on one of these branches also satisfies
   * the check — this is how a bakery partner's own staff reach the queue at
   * their counter. Omitted, only a GLOBAL grant will do, which is what every
   * platform-wide surface wants.
   *
   * Note this widens *who* passes, not *what* they may then touch. The caller
   * still has to confine the rows it reads and writes to those branches; a
   * branch grant getting through here and then operating a neighbouring
   * bakery's order would be the whole failure this exists to prevent.
   */
  branchIds?: readonly string[],
): Promise<boolean> {
  const scopes: Prisma.AccessGrantWhereInput[] = [{ scopeType: 'GLOBAL', scopeId: null }]
  if (branchIds?.length) {
    scopes.push({ scopeType: 'BAKERY_BRANCH', scopeId: { in: [...branchIds] } })
  }

  const authorized = await transaction.identityAccount.findFirst({
    where: {
      id: accountId,
      status: 'ACTIVE',
      tenantMemberships: {
        some: {
          tenantId,
          status: 'ACTIVE',
          activeAt: { lte: now },
          suspendedAt: null,
          revokedAt: null,
        },
      },
      accessGrants: {
        some: {
          OR: scopes,
          activeAt: { lte: now },
          revokedAt: null,
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
          role: { permissions: { some: { permission: { code: permission } } } },
        },
      },
    },
    select: { id: true },
  })
  return authorized !== null
}

/**
 * The branches a session's own grants confine it to, or null for tenant-wide.
 *
 * Null and an empty array are different answers and the difference is the whole
 * point: null means "this account holds the permission at GLOBAL scope, so no
 * branch filter applies", and an empty array means "this account holds it at no
 * scope at all", which every caller must treat as a refusal rather than as an
 * unfiltered read.
 */
export function branchScopeFromGrants(
  grants: ReadonlyArray<{
    permissions: string[]
    scopeType: string
    scopeId: string | null
    expiresAt: string | null
  }>,
  permission: string,
  now: Date,
): readonly string[] | null {
  const branches: string[] = []
  for (const grant of grants) {
    if (!grant.permissions.includes(permission)) continue
    if (grant.expiresAt && new Date(grant.expiresAt) <= now) continue
    if (grant.scopeType === 'GLOBAL' && grant.scopeId === null) return null
    if (grant.scopeType === 'BAKERY_BRANCH' && grant.scopeId) branches.push(grant.scopeId)
  }
  return [...new Set(branches)]
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
