import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS, MESSAGE_TEMPLATE_DEFINITIONS } from '@alo-noon/domain'

import {
  createPrismaAdminMessagingService,
  type AdminMessagingService,
} from './modules/admin-messaging'

/**
 * Message template authoring against PostgreSQL.
 *
 * What is worth testing against real rows rather than a mock is everything the
 * database itself refuses: a template cannot be repointed at another purpose,
 * its version has to climb, and the sign-in message cannot be switched off.
 * Those are guards, not application logic, and a mock would agree with whatever
 * the service happened to do.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: AdminMessagingService = createPrismaAdminMessagingService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')

interface Fixture {
  tenantId: string
  governorId: string
  outsiderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('message templates over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('lists every message before anything has been customised', async () => {
    const { templates } = await service.list(fixture.tenantId, 'SMS')

    // A tenant with no rows is not a tenant sending nothing — it is a tenant
    // sending the defaults, and the operator has to be able to see them.
    expect(templates).toHaveLength(MESSAGE_TEMPLATE_DEFINITIONS.length)
    expect(templates.every((template) => !template.customized)).toBe(true)
    expect(templates.every((template) => template.body === template.defaultBody)).toBe(true)
    const otp = templates.find((template) => template.purpose === 'AUTH_OTP')
    expect(otp?.preview).not.toMatch(/[{}]/)
    expect(otp?.segments).toBe(1)
  })

  it('refuses an account without notification governance', async () => {
    await expect(
      service.update(
        fixture.tenantId,
        { accountId: fixture.outsiderId },
        'SMS',
        'ORDER_READY',
        { body: 'سفارش {orderCode} آماده است', enabled: true },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'MESSAGING_OPERATION_FORBIDDEN', status: 403 })
  })

  it('refuses a variable the purpose cannot supply, and says which one', async () => {
    await expect(
      service.update(
        fixture.tenantId,
        { accountId: fixture.governorId },
        'SMS',
        'AUTH_OTP',
        { body: 'کد {code} برای سفارش {orderCode}', enabled: true },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: 'MESSAGE_TEMPLATE_INVALID',
      status: 422,
      problems: [{ code: 'UNKNOWN_VARIABLE', name: 'orderCode' }],
    })
  })

  it('saves a template, records who changed it, and keeps the old wording', async () => {
    const first = await service.update(
      fixture.tenantId,
      { accountId: fixture.governorId },
      'SMS',
      'ORDER_READY',
      { body: 'سفارش {orderCode} آمادهٔ تحویل است.', enabled: true },
      now,
      randomUUID(),
    )
    expect(first).toMatchObject({ customized: true, version: 1, segments: 1 })
    expect(first.preview).toBe('سفارش A7K2M9 آمادهٔ تحویل است.')

    const correlationId = randomUUID()
    const second = await service.update(
      fixture.tenantId,
      { accountId: fixture.governorId },
      'SMS',
      'ORDER_READY',
      { body: 'نان شما آماده است. کد سفارش: {orderCode}', enabled: true },
      now,
      correlationId,
    )
    expect(second.version).toBe(2)

    const event = await prisma.domainEventOutbox.findFirst({ where: { correlationId } })
    // The wording that was live when a disputed message was sent has to stay
    // readable after someone edits it.
    expect(event?.payload).toMatchObject({
      purpose: 'ORDER_READY',
      version: 2,
      previousBody: 'سفارش {orderCode} آمادهٔ تحویل است.',
    })
    const audit = await prisma.auditEvent.findFirst({ where: { correlationId } })
    expect(audit?.actorId).toBe(fixture.governorId)
  })

  it('refuses to switch off the one message nobody can sign in without', async () => {
    await expect(
      service.update(
        fixture.tenantId,
        { accountId: fixture.governorId },
        'SMS',
        'AUTH_OTP',
        { body: 'کد ورود: {code}', enabled: false },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_TEMPLATE_OTP_REQUIRED', status: 422 })

    // And the database refuses it too, so the service is not the only guard.
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.messageTemplate.create({
          data: {
            tenantId: fixture.tenantId,
            channel: 'SMS',
            purpose: 'AUTH_OTP',
            body: 'کد ورود: {code}',
            enabled: false,
          },
        })
      }),
    ).rejects.toThrow(/cannot be disabled/)
  })

  it('refuses to repoint a saved template at another purpose', async () => {
    const saved = await service.update(
      fixture.tenantId,
      { accountId: fixture.governorId },
      'SMS',
      'ORDER_COMPLETED',
      { body: 'سفارش {orderCode} تحویل شد.', enabled: true },
      now,
      randomUUID(),
    )
    expect(saved.customized).toBe(true)

    // Repointing would swap the message customers get at one step of the order
    // for the one meant for another, and read as an ordinary wording edit.
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.$executeRaw`
          UPDATE "MessageTemplate"
          SET "purpose" = 'ORDER_CANCELLED', "version" = "version" + 1
          WHERE "tenantId" = ${fixture.tenantId}::uuid AND "purpose" = 'ORDER_COMPLETED'`
      }),
    ).rejects.toThrow(/identity is immutable/)
  })

  it('requires every edit to climb a version', async () => {
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
        await transaction.$executeRaw`
          UPDATE "MessageTemplate"
          SET "body" = 'متن تازه با {orderCode}'
          WHERE "tenantId" = ${fixture.tenantId}::uuid AND "purpose" = 'ORDER_COMPLETED'`
      }),
    ).rejects.toThrow(/version must increase/)
  })

  it('resolves the wording the sender will use, customised or not', async () => {
    const customised = await service.resolve(fixture.tenantId, 'SMS', 'ORDER_READY')
    expect(customised).toMatchObject({ customized: true, enabled: true })
    expect(customised.body).toContain('{orderCode}')

    const untouched = await service.resolve(fixture.tenantId, 'SMS', 'ORDER_REJECTED')
    expect(untouched).toMatchObject({ customized: false, enabled: true, version: 0 })
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `messaging-${suffix.toLowerCase()}`, name: `Messaging ${suffix}` },
  })
  const tenantId = tenant.id
  return {
    tenantId,
    governorId: await createAccount(tenantId, `MSG_GOVERNOR_${suffix}`, [
      ADMIN_PERMISSIONS.notificationProviderGovern,
    ]),
    outsiderId: await createAccount(tenantId, null, []),
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '5').slice(0, 9)}`
}

async function createAccount(
  tenantId: string,
  roleCode: string | null,
  permissions: readonly string[],
): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: { mobileE164: uniqueMobile(), verifiedAt: now },
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
