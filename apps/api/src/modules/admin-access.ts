import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@alo-noon/database'
import type {
  AdminRoleSummary,
  GrantRoleCommand,
  RevokeRoleCommand,
  StaffMember,
} from '@alo-noon/contracts'
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  adminRoleCodes,
  findAdminRole,
  permissionsBeyond,
  type AdminRoleDefinition,
} from '@alo-noon/domain'

import { holdsPermissionInTransaction } from './admin-auth.js'

/**
 * Staff access management: who may operate this tenant, and with what.
 *
 * The rule that matters here is not "may this account manage access" — the
 * route already checked that — but "may it grant *this* role". Without the
 * second question an ACCESS_ADMIN, whose only permission is to manage access,
 * could hand itself TENANT_ADMIN and own the tenant. Every grant is therefore
 * measured against what the granter already holds, and a role carrying anything
 * more is refused.
 *
 * An account cannot revoke its own grant. The reasoning is not that
 * self-revocation is dangerous — it is recoverable, from the provisioning CLI —
 * but that it is never what someone meant to click, and the recovery requires
 * shell access to the database server.
 *
 * One subtlety in the schema: `AccessGrant` has no tenant column. A grant
 * attaches to an account, and it is the account's tenant membership that scopes
 * it. Every query here joins through an active membership, so an account
 * belonging to two tenants is only ever listed and altered under the tenant the
 * caller is acting in.
 */
export interface AccessActor {
  accountId: string
  /** Permissions the caller's session carries, used to refuse escalation. */
  permissions: readonly string[]
}

export class AdminAccessError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(code)
    this.name = 'AdminAccessError'
  }
}

export interface AdminAccessService {
  listRoles(actor: AccessActor): AdminRoleSummary[]
  listStaff(tenantId: string, actor: AccessActor): Promise<StaffMember[]>
  grantRole(
    tenantId: string,
    actor: AccessActor,
    command: GrantRoleCommand,
    now: Date,
    correlationId: string,
  ): Promise<StaffMember>
  revokeRole(
    tenantId: string,
    actor: AccessActor,
    command: RevokeRoleCommand,
    now: Date,
    correlationId: string,
  ): Promise<StaffMember>
}

export function createPrismaAdminAccessService(prisma: PrismaClient): AdminAccessService {
  return {
    listRoles(actor) {
      return ADMIN_ROLES.map((role) => ({
        code: role.code,
        name: role.name,
        permissions: [...role.permissions],
        grantable: permissionsBeyond(role, actor.permissions).length === 0,
      }))
    },

    async listStaff(tenantId, actor) {
      return readTransaction(prisma, tenantId, async (transaction) => {
        const accounts = await loadStaffAccounts(transaction, tenantId, actor, undefined)
        return accounts
      })
    },

    async grantRole(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const definition = knownRole(command.roleCode)
        // The escalation guard. Measured against the caller's live permissions,
        // re-read here rather than taken from the session, so a caller whose own
        // access was narrowed a minute ago cannot still hand out the wider set.
        const live = await livePermissions(transaction, tenantId, actor.accountId, now)
        const beyond = permissionsBeyond(definition, live)
        if (beyond.length > 0) throw new AdminAccessError('ROLE_EXCEEDS_GRANTER', 403)

        const account = await transaction.identityAccount.findFirst({
          where: { mobileE164: command.mobileE164 },
          select: { id: true, status: true },
        })
        // Signing in with OTP is what creates the account, and it is also what
        // proves whoever holds that number asked to be here.
        if (!account) throw new AdminAccessError('ACCOUNT_NOT_FOUND', 404)
        if (account.status !== 'ACTIVE') throw new AdminAccessError('ACCOUNT_NOT_ACTIVE', 409)

        const membership = await transaction.tenantMembership.findFirst({
          where: { tenantId, accountId: account.id, status: 'ACTIVE', revokedAt: null },
          select: { id: true },
        })
        if (!membership) throw new AdminAccessError('ACCOUNT_NOT_IN_TENANT', 409)

        const role = await ensureRole(transaction, definition, now)
        const existing = await transaction.accessGrant.findFirst({
          where: {
            accountId: account.id,
            roleId: role.id,
            scopeType: 'GLOBAL',
            scopeId: null,
            revokedAt: null,
          },
          select: { id: true },
        })
        // Idempotent: re-granting what someone already holds is a no-op, not an
        // error, because an operator re-submitting a form should not have to
        // wonder whether they undid something.
        if (!existing) {
          const grant = await transaction.accessGrant.create({
            data: {
              accountId: account.id,
              roleId: role.id,
              // Admin capabilities are tenant-wide; the routes accept nothing
              // narrower, so a city- or branch-scoped grant would be dead weight.
              scopeType: 'GLOBAL',
              activeAt: now,
              createdAt: now,
              updatedAt: now,
            },
          })
          await recordAccessChange(transaction, tenantId, actor, {
            action: 'authorization.role.granted',
            entityId: grant.id,
            summary: `Role ${definition.code} granted to ${command.mobileE164}`,
            payload: {
              roleCode: definition.code,
              targetAccountId: account.id,
              permissions: [...definition.permissions],
              reason: command.reason,
            },
            correlationId,
            now,
          })
        }

        return oneStaffMember(transaction, tenantId, actor, account.id)
      })
    },

    async revokeRole(tenantId, actor, command, now, correlationId) {
      return writeTransaction(prisma, tenantId, actor, now, async (transaction) => {
        const grant = await transaction.accessGrant.findFirst({
          where: {
            id: command.grantId,
            revokedAt: null,
            // Scoped through membership: a grant on an account outside this
            // tenant is not this tenant's to revoke.
            account: {
              tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } },
            },
          },
          select: {
            id: true,
            accountId: true,
            account: { select: { mobileE164: true } },
            role: { select: { code: true } },
          },
        })
        if (!grant) throw new AdminAccessError('GRANT_NOT_FOUND', 404)
        if (grant.accountId === actor.accountId) {
          throw new AdminAccessError('CANNOT_REVOKE_SELF', 409)
        }

        // Revoking a role the caller could not have granted would let a narrow
        // operator strip a wider one — escalation by subtraction.
        const definition = findAdminRole(grant.role.code)
        if (definition) {
          const live = await livePermissions(transaction, tenantId, actor.accountId, now)
          if (permissionsBeyond(definition, live).length > 0) {
            throw new AdminAccessError('ROLE_EXCEEDS_GRANTER', 403)
          }
        }

        await transaction.accessGrant.update({
          where: { id: grant.id },
          data: { revokedAt: now, updatedAt: now },
        })
        await recordAccessChange(transaction, tenantId, actor, {
          action: 'authorization.role.revoked',
          entityId: grant.id,
          summary: `Role ${grant.role.code} revoked from ${grant.account.mobileE164}`,
          payload: {
            roleCode: grant.role.code,
            targetAccountId: grant.accountId,
            reason: command.reason,
          },
          correlationId,
          now,
        })

        return oneStaffMember(transaction, tenantId, actor, grant.accountId)
      })
    },
  }
}

function knownRole(code: string): AdminRoleDefinition {
  const definition = findAdminRole(code)
  if (!definition) throw new AdminAccessError('ROLE_UNKNOWN', 400)
  return definition
}

/**
 * The permissions an account holds right now, from unexpired GLOBAL grants.
 *
 * Deliberately not the session's copy: the session is a snapshot taken at
 * sign-in, and the whole point of re-reading inside the write transaction is
 * that a revocation between then and now must count.
 */
async function livePermissions(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  now: Date,
): Promise<readonly string[]> {
  const grants = await transaction.accessGrant.findMany({
    where: {
      accountId,
      scopeType: 'GLOBAL',
      scopeId: null,
      revokedAt: null,
      activeAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      account: { tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } } },
    },
    select: { role: { select: { permissions: { select: { permission: true } } } } },
  })
  const permissions = new Set<string>()
  for (const grant of grants) {
    for (const entry of grant.role.permissions) permissions.add(entry.permission.code)
  }
  return [...permissions]
}

/**
 * Creates the role row on first use and reconciles its permissions.
 *
 * The role catalogue lives in the domain package, and the database rows are a
 * projection of it. Reconciling on every grant means a permission added to a
 * role in code reaches accounts that already hold it, rather than only new ones.
 */
async function ensureRole(
  transaction: Prisma.TransactionClient,
  definition: AdminRoleDefinition,
  now: Date,
): Promise<{ id: string }> {
  const role = await transaction.authorizationRole.upsert({
    where: { code: definition.code },
    update: { name: definition.name, updatedAt: now },
    create: { code: definition.code, name: definition.name, createdAt: now, updatedAt: now },
    select: { id: true },
  })
  for (const code of definition.permissions) {
    const permission = await transaction.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: permissionDescription(code), createdAt: now, updatedAt: now },
      select: { id: true },
    })
    await transaction.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id, createdAt: now },
    })
  }
  return role
}

function permissionDescription(code: string): string {
  return ADMIN_ROLES.flatMap((role) => role.permissions).includes(code as never)
    ? `Admin permission ${code}`
    : `Permission ${code}`
}

async function oneStaffMember(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: AccessActor,
  accountId: string,
): Promise<StaffMember> {
  const [member] = await loadStaffAccounts(transaction, tenantId, actor, accountId)
  if (!member) throw new AdminAccessError('ACCOUNT_NOT_FOUND', 404)
  return member
}

/**
 * Every account in this tenant that holds — or has held and now holds none of —
 * an admin role. Accounts with no admin grant at all are omitted: the tenant's
 * customers are also identity accounts, and listing them here would turn an
 * access screen into a customer directory.
 */
async function loadStaffAccounts(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: AccessActor,
  onlyAccountId: string | undefined,
): Promise<StaffMember[]> {
  const roleCodes = [...adminRoleCodes()]
  const accounts = await transaction.identityAccount.findMany({
    where: {
      ...(onlyAccountId && { id: onlyAccountId }),
      tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } },
      accessGrants: { some: { role: { code: { in: roleCodes } } } },
    },
    select: {
      id: true,
      mobileE164: true,
      status: true,
      accessGrants: {
        where: { revokedAt: null, scopeType: 'GLOBAL', role: { code: { in: roleCodes } } },
        orderBy: { activeAt: 'asc' },
        select: {
          id: true,
          activeAt: true,
          expiresAt: true,
          role: {
            select: { code: true, name: true, permissions: { select: { permission: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return accounts.map((account) => {
    const permissions = new Set<string>()
    for (const grant of account.accessGrants) {
      for (const entry of grant.role.permissions) permissions.add(entry.permission.code)
    }
    return {
      accountId: account.id,
      mobileE164: account.mobileE164,
      status: account.status as StaffMember['status'],
      roles: account.accessGrants.map((grant) => ({
        grantId: grant.id,
        code: grant.role.code,
        name: grant.role.name,
        grantedAt: grant.activeAt.toISOString(),
        expiresAt: grant.expiresAt?.toISOString() ?? null,
      })),
      permissions: [...permissions],
      isSelf: account.id === actor.accountId,
    }
  })
}

interface AccessChange {
  action: string
  entityId: string
  summary: string
  payload: Prisma.InputJsonObject
  correlationId: string
  now: Date
}

/**
 * Access changes are the ones an auditor asks about first, so both records are
 * written: the audit event that says who did it and why, and the domain event
 * that lets anything downstream notice a privilege moved.
 */
async function recordAccessChange(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actor: AccessActor,
  change: AccessChange,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      tenantId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      action: change.action,
      entityType: 'access_grant',
      entityId: change.entityId,
      summary: change.summary,
      correlationId: change.correlationId,
      metadata: change.payload,
      occurredAt: change.now,
    },
  })
  await transaction.domainEventOutbox.create({
    data: {
      tenantId,
      eventId: randomUUID(),
      name: change.action,
      aggregateType: 'access_grant',
      aggregateId: change.entityId,
      actorType: 'STAFF',
      actorId: actor.accountId,
      correlationId: change.correlationId,
      consentBasis: 'NOT_REQUIRED',
      payload: change.payload,
      occurredAt: change.now,
    },
  })
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

async function writeTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  actor: AccessActor,
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
          ADMIN_PERMISSIONS.accessManage,
          now,
        )
        if (!permitted) throw new AdminAccessError('ACCESS_OPERATION_FORBIDDEN', 403)
        return operation(transaction)
      },
      // Two operators granting concurrently must not both read "no grant yet"
      // and both insert; SERIALIZABLE turns that into a retryable conflict.
      { isolationLevel: 'Serializable' },
    )
  } catch (error) {
    if (error && typeof error === 'object') {
      const code = Reflect.get(error, 'code')
      if (code === 'P2002' || code === 'P2034') {
        throw new AdminAccessError('ACCESS_WRITE_CONFLICT', 409)
      }
    }
    throw error
  }
}
