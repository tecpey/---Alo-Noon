import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import { createPrismaAdminAccessService, type AdminAccessService } from './modules/admin-access'

/**
 * Exercises staff access management against PostgreSQL.
 *
 * The rules here are the ones that decide who owns the tenant, so each is
 * tested against real rows rather than a mocked repository: an ACCESS_ADMIN
 * must not be able to promote itself, revocation must be measured by the same
 * yardstick as granting, and an account must not be able to lock itself out.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: AdminAccessService = createPrismaAdminAccessService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')

interface Fixture {
  tenantId: string
  /** Holds every admin permission. */
  ownerId: string
  ownerPermissions: readonly string[]
  /** Holds only admin.access.manage. */
  accessAdminId: string
  /** A member with no admin role at all. */
  newcomerId: string
  newcomerMobile: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('admin access management over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('refuses an account that cannot manage access', async () => {
    await expect(
      service.grantRole(
        fixture.tenantId,
        { accountId: fixture.newcomerId, permissions: [] },
        {
          mobileE164: fixture.newcomerMobile,
          roleCode: 'OPERATIONS_ANALYST',
          reason: 'خودم به خودم',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_OPERATION_FORBIDDEN', status: 403 })
  })

  it('refuses a role carrying more than the granter holds', async () => {
    // The whole point of separating ACCESS_ADMIN from TENANT_ADMIN: an account
    // whose only power is to manage access must not be able to grant itself the
    // rest of the tenant.
    await expect(
      service.grantRole(
        fixture.tenantId,
        {
          accountId: fixture.accessAdminId,
          permissions: [ADMIN_PERMISSIONS.accessManage],
        },
        {
          mobileE164: fixture.newcomerMobile,
          roleCode: 'TENANT_ADMIN',
          reason: 'ارتقای غیرمجاز',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_EXCEEDS_GRANTER', status: 403 })

    const granted = await prisma.accessGrant.count({
      where: { accountId: fixture.newcomerId, revokedAt: null },
    })
    expect(granted).toBe(0)
  })

  it('measures the escalation guard against live grants, not the session', async () => {
    // A session that still claims TENANT_ADMIN after the grant behind it was
    // revoked must not be able to spend it. The caller here is the ACCESS_ADMIN
    // with a lying permission list.
    await expect(
      service.grantRole(
        fixture.tenantId,
        {
          accountId: fixture.accessAdminId,
          permissions: [...fixture.ownerPermissions],
        },
        {
          mobileE164: fixture.newcomerMobile,
          roleCode: 'TENANT_ADMIN',
          reason: 'نشست منقضی',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_EXCEEDS_GRANTER', status: 403 })
  })

  it('grants a role and records who did it and why', async () => {
    const member = await service.grantRole(
      fixture.tenantId,
      { accountId: fixture.ownerId, permissions: fixture.ownerPermissions },
      {
        mobileE164: fixture.newcomerMobile,
        roleCode: 'CATALOG_MANAGER',
        reason: 'مسئول کاتالوگ شعبهٔ مرکزی',
      },
      now,
      randomUUID(),
    )

    expect(member.roles.map((role) => role.code)).toEqual(['CATALOG_MANAGER'])
    expect(member.permissions).toContain(ADMIN_PERMISSIONS.catalogManage)
    expect(member.isSelf).toBe(false)

    const audit = await prisma.auditEvent.findFirst({
      where: { tenantId: fixture.tenantId, action: 'authorization.role.granted' },
      orderBy: { occurredAt: 'desc' },
    })
    expect(audit?.actorId).toBe(fixture.ownerId)
    expect(audit?.metadata).toMatchObject({ roleCode: 'CATALOG_MANAGER' })
  })

  it('treats re-granting what someone already holds as a no-op', async () => {
    const before = await prisma.accessGrant.count({
      where: { accountId: fixture.newcomerId, revokedAt: null },
    })
    const member = await service.grantRole(
      fixture.tenantId,
      { accountId: fixture.ownerId, permissions: fixture.ownerPermissions },
      {
        mobileE164: fixture.newcomerMobile,
        roleCode: 'CATALOG_MANAGER',
        reason: 'ارسال دوبارهٔ فرم',
      },
      now,
      randomUUID(),
    )
    const after = await prisma.accessGrant.count({
      where: { accountId: fixture.newcomerId, revokedAt: null },
    })
    expect(after).toBe(before)
    expect(member.roles).toHaveLength(1)
  })

  it('refuses a number that has never signed in', async () => {
    await expect(
      service.grantRole(
        fixture.tenantId,
        { accountId: fixture.ownerId, permissions: fixture.ownerPermissions },
        { mobileE164: '+989350000000', roleCode: 'OPERATIONS_ANALYST', reason: 'هنوز وارد نشده' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND', status: 404 })
  })

  it('refuses to let an account revoke itself', async () => {
    const staff = await service.listStaff(fixture.tenantId, {
      accountId: fixture.ownerId,
      permissions: fixture.ownerPermissions,
    })
    const self = staff.find((member) => member.isSelf)
    expect(self?.roles[0]).toBeDefined()

    await expect(
      service.revokeRole(
        fixture.tenantId,
        { accountId: fixture.ownerId, permissions: fixture.ownerPermissions },
        { grantId: self!.roles[0]!.grantId, reason: 'اشتباه کلیک شد' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CANNOT_REVOKE_SELF', status: 409 })
  })

  it('refuses to let a narrow operator strip a wider one', async () => {
    const staff = await service.listStaff(fixture.tenantId, {
      accountId: fixture.accessAdminId,
      permissions: [ADMIN_PERMISSIONS.accessManage],
    })
    const owner = staff.find((member) => member.accountId === fixture.ownerId)
    expect(owner).toBeDefined()

    // Escalation by subtraction: removing everyone wider would leave the
    // narrow operator alone in the tenant.
    await expect(
      service.revokeRole(
        fixture.tenantId,
        { accountId: fixture.accessAdminId, permissions: [ADMIN_PERMISSIONS.accessManage] },
        { grantId: owner!.roles[0]!.grantId, reason: 'حذف مدیر' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_EXCEEDS_GRANTER', status: 403 })
  })

  it('revokes a role and drops it from the account permissions', async () => {
    const staff = await service.listStaff(fixture.tenantId, {
      accountId: fixture.ownerId,
      permissions: fixture.ownerPermissions,
    })
    const newcomer = staff.find((member) => member.accountId === fixture.newcomerId)
    const grantId = newcomer?.roles.find((role) => role.code === 'CATALOG_MANAGER')?.grantId
    expect(grantId).toBeDefined()

    const after = await service.revokeRole(
      fixture.tenantId,
      { accountId: fixture.ownerId, permissions: fixture.ownerPermissions },
      { grantId: grantId!, reason: 'پایان همکاری' },
      new Date(now.getTime() + 60_000),
      randomUUID(),
    )
    expect(after.roles).toHaveLength(0)
    expect(after.permissions).toEqual([])

    const audit = await prisma.auditEvent.findFirst({
      where: { tenantId: fixture.tenantId, action: 'authorization.role.revoked' },
      orderBy: { occurredAt: 'desc' },
    })
    expect(audit?.actorId).toBe(fixture.ownerId)
  })

  it('marks each role with whether the caller could grant it', () => {
    const asAccessAdmin = service.listRoles({
      accountId: fixture.accessAdminId,
      permissions: [ADMIN_PERMISSIONS.accessManage],
    })
    expect(asAccessAdmin.find((role) => role.code === 'ACCESS_ADMIN')?.grantable).toBe(true)
    expect(asAccessAdmin.find((role) => role.code === 'TENANT_ADMIN')?.grantable).toBe(false)

    const asOwner = service.listRoles({
      accountId: fixture.ownerId,
      permissions: fixture.ownerPermissions,
    })
    expect(asOwner.every((role) => role.grantable)).toBe(true)
  })

  it('lists only accounts holding an admin role, not every tenant member', async () => {
    const staff = await service.listStaff(fixture.tenantId, {
      accountId: fixture.ownerId,
      permissions: fixture.ownerPermissions,
    })
    // The newcomer's grant was revoked, but the account held one, so it stays
    // listed with an empty role set — an operator needs to see that history.
    const ids = staff.map((member) => member.accountId)
    expect(ids).toContain(fixture.ownerId)
    expect(ids).toContain(fixture.accessAdminId)
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `access-${suffix.toLowerCase()}`, name: `Access ${suffix}` },
  })
  const tenantId = tenant.id

  const ownerPermissions = Object.values(ADMIN_PERMISSIONS)
  const ownerId = await createAccount(tenantId, 'TENANT_ADMIN', ownerPermissions)
  const accessAdminId = await createAccount(tenantId, 'ACCESS_ADMIN', [
    ADMIN_PERMISSIONS.accessManage,
  ])
  const newcomerMobile = uniqueMobile()
  const newcomerId = await createAccount(tenantId, null, [], newcomerMobile)

  return {
    tenantId,
    ownerId,
    ownerPermissions,
    accessAdminId,
    newcomerId,
    newcomerMobile,
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '5').slice(0, 9)}`
}

async function createAccount(
  tenantId: string,
  roleCode: string | null,
  permissions: readonly string[],
  mobileE164 = uniqueMobile(),
): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: { mobileE164, verifiedAt: now },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.tenantMembership.create({
      data: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
    })
  })
  if (!roleCode) return account.id

  const role = await prisma.authorizationRole.upsert({
    where: { code: roleCode },
    update: {},
    create: { code: roleCode, name: roleCode },
  })
  for (const code of permissions) {
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: `Integration permission ${code}` },
    })
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })
  return account.id
}
