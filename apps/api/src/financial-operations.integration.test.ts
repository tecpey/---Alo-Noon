import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { SYSTEM_LEDGER_ACCOUNT_TEMPLATES } from '@alo-noon/domain'

import { createPrismaFinancialOperationsService } from './modules/financial-operations'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantA = randomUUID()
const tenantB = randomUUID()
const roleName = `financial_ops_${randomUUID().replaceAll('-', '')}`
let roleCreated = false
let authorizedStaffId = ''

databaseDescribe('chart-of-accounts PostgreSQL foundation', () => {
  beforeAll(async () => {
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, slug: `finance-a-${tenantA.slice(0, 8)}`, name: 'Finance tenant A' },
        { id: tenantB, slug: `finance-b-${tenantB.slice(0, 8)}`, name: 'Finance tenant B' },
      ],
    })
    const staff = await prisma.identityAccount.create({
      data: {
        mobileE164: `+989${randomUUID().replaceAll('-', '').slice(0, 9)}`,
        verifiedAt: new Date('2026-08-03T11:00:00.000Z'),
      },
    })
    authorizedStaffId = staff.id
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
      await transaction.tenantMembership.create({
        data: {
          tenantId: tenantA,
          accountId: staff.id,
          status: 'ACTIVE',
          activeAt: new Date('2026-08-03T11:00:00.000Z'),
        },
      })
    })
    const permission = await prisma.authorizationPermission.upsert({
      where: { code: 'financial.ledger-account.govern' },
      update: {},
      create: {
        code: 'financial.ledger-account.govern',
        description: 'Activate or deactivate governed tenant ledger accounts',
      },
    })
    const authorizationRole = await prisma.authorizationRole.create({
      data: { code: `FINANCIAL_OPERATOR_${tenantA.slice(0, 8)}`, name: 'Financial operator' },
    })
    await prisma.rolePermission.create({
      data: { roleId: authorizationRole.id, permissionId: permission.id },
    })
    await prisma.accessGrant.create({
      data: {
        accountId: staff.id,
        roleId: authorizationRole.id,
        scopeType: 'GLOBAL',
        activeAt: new Date('2026-08-03T11:00:00.000Z'),
      },
    })
    await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    roleCreated = true
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
    for (const table of [
      'LedgerAccount',
      'TenantFinancialBootstrap',
      'LedgerAccountGovernanceEvent',
    ]) {
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "${roleName}"`,
      )
    }
  })

  afterAll(async () => {
    if (roleCreated) {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
    }
    await prisma.$disconnect()
  })

  it('automatically and idempotently provisions a complete deterministic hierarchy', async () => {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { tenantId: tenantA, isSystem: true },
      include: { parent: { select: { systemKey: true } } },
      orderBy: { code: 'asc' },
    })
    // The fourteen of chart v1. v2 added a courier cash receivable and stopped
    // provisioning it when the platform stopped taking money at doors.
    expect(accounts).toHaveLength(14)
    expect(accounts.filter(({ parentId }) => parentId === null)).toHaveLength(5)
    expect(
      accounts.filter(({ parentId }) => parentId === null).every(({ isPostable }) => !isPostable),
    ).toBe(true)
    expect(
      accounts.every(
        ({ currency, isActive, governanceVersion }) =>
          currency === 'IRR' && isActive && governanceVersion === 1,
      ),
    ).toBe(true)
    expect(
      accounts.map((account) => ({
        key: account.systemKey,
        code: account.code,
        name: account.name,
        type: account.type,
        parentKey: account.parent?.systemKey ?? null,
        isPostable: account.isPostable,
      })),
    ).toEqual(
      [...SYSTEM_LEDGER_ACCOUNT_TEMPLATES].sort((left, right) =>
        left.code.localeCompare(right.code),
      ),
    )
    expect(
      await prisma.ledgerAccountGovernanceEvent.count({
        where: { tenantId: tenantA, action: 'PROVISIONED' },
      }),
    ).toBe(14)

    const service = createPrismaFinancialOperationsService(prisma)
    const first = await service.provision(
      tenantA,
      { idempotencyKey: 'financial-bootstrap-replay-0001' },
      new Date('2026-08-03T12:00:00.000Z'),
      randomUUID(),
    )
    const replay = await service.provision(
      tenantA,
      { idempotencyKey: 'financial-bootstrap-replay-0002' },
      new Date('2026-08-03T12:01:00.000Z'),
      randomUUID(),
    )
    expect(replay).toEqual(first)
    expect(first).toMatchObject({ tenantId: tenantA, templateVersion: 1, accountCount: 14 })
    // One bootstrap row per chart version that provisioned something. v2 added
    // a courier cash receivable and stopped adding it when the platform stopped
    // taking money at doors, so a tenant created now records only v1.
    expect(await prisma.tenantFinancialBootstrap.count({ where: { tenantId: tenantA } })).toBe(1)
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: tenantA, action: 'financial.chart_provisioned' },
      }),
    ).toBe(1)
    expect(
      await prisma.domainEventOutbox.count({
        where: { tenantId: tenantA, name: 'financial.chart_provisioned' },
      }),
    ).toBe(1)
  })

  it('governs activation atomically with audit, outbox, replay and rollback safety', async () => {
    const service = createPrismaFinancialOperationsService(prisma)
    const leaf = await prisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: tenantA, systemKey: 'DELIVERY_EXPENSE' },
    })
    const actorId = authorizedStaffId
    const command = {
      accountId: leaf.id,
      targetActive: false,
      actor: 'STAFF' as const,
      actorId,
      idempotencyKey: 'ledger-deactivate-delivery-0001',
      reason: 'No new delivery postings during controlled maintenance',
    }
    const changed = await service.setAccountActive(
      tenantA,
      command,
      new Date('2026-08-03T12:10:00.000Z'),
      randomUUID(),
    )
    expect(changed).toMatchObject({ id: leaf.id, isActive: false, governanceVersion: 2 })
    expect(
      await service.setAccountActive(
        tenantA,
        command,
        new Date('2026-08-03T12:11:00.000Z'),
        randomUUID(),
      ),
    ).toEqual(changed)
    await expect(
      service.setAccountActive(
        tenantA,
        { ...command, reason: 'Different payload under the same key' },
        new Date('2026-08-03T12:11:00.000Z'),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    const otherLeaf = await prisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: tenantA, systemKey: 'PAYMENT_PROCESSING_EXPENSE' },
    })
    await expect(
      service.setAccountActive(
        tenantA,
        { ...command, accountId: otherLeaf.id },
        new Date('2026-08-03T12:11:00.000Z'),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await expect(
      service.setAccountActive(
        tenantA,
        {
          ...command,
          actorId: randomUUID(),
          idempotencyKey: 'ledger-unauthorized-actor-0001',
        },
        new Date('2026-08-03T12:11:00.000Z'),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FINANCIAL_OPERATION_FORBIDDEN' })
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: tenantA,
          entityId: leaf.id,
          action: 'financial.ledger_account_state_changed',
        },
      }),
    ).toBe(1)
    expect(
      await prisma.domainEventOutbox.count({
        where: {
          tenantId: tenantA,
          aggregateId: leaf.id,
          name: 'financial.ledger_account_state_changed',
        },
      }),
    ).toBe(1)

    const failing = createPrismaFinancialOperationsService(prisma, {
      beforeCommit: async () => {
        throw new Error('INJECTED_GOVERNANCE_ROLLBACK')
      },
    })
    await expect(
      failing.setAccountActive(
        tenantA,
        {
          ...command,
          targetActive: true,
          idempotencyKey: 'ledger-activate-rollback-0001',
          reason: 'Injected rollback verification',
        },
        new Date('2026-08-03T12:12:00.000Z'),
        randomUUID(),
      ),
    ).rejects.toThrow('INJECTED_GOVERNANCE_ROLLBACK')
    expect(
      (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: leaf.id } })).isActive,
    ).toBe(false)
    expect(
      await prisma.ledgerAccountGovernanceEvent.count({
        where: { ledgerAccountId: leaf.id, idempotencyKey: 'ledger-activate-rollback-0001' },
      }),
    ).toBe(0)

    const activated = await service.setAccountActive(
      tenantA,
      {
        ...command,
        targetActive: true,
        idempotencyKey: 'ledger-activate-delivery-0001',
        reason: 'Controlled maintenance completed',
      },
      new Date('2026-08-03T12:13:00.000Z'),
      randomUUID(),
    )
    expect(activated).toMatchObject({ isActive: true, governanceVersion: 3 })
    expect(
      await service.setAccountActive(
        tenantA,
        command,
        new Date('2026-08-03T12:14:00.000Z'),
        randomUUID(),
      ),
    ).toMatchObject({ isActive: false, governanceVersion: 2 })
  })

  it('rejects unsafe hierarchy, ungoverned state mutation, and system identity mutation', async () => {
    const service = createPrismaFinancialOperationsService(prisma, {
      allowSystemGovernance: true,
    })
    const root = await prisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: tenantA, systemKey: 'ASSETS' },
    })
    await expect(
      service.setAccountActive(
        tenantA,
        {
          accountId: root.id,
          targetActive: false,
          actor: 'SYSTEM',
          idempotencyKey: 'ledger-deactivate-root-0001',
          reason: 'Unsafe root request',
        },
        new Date('2026-08-03T12:20:00.000Z'),
        randomUUID(),
      ),
    ).rejects.toThrow('active children')
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.ledgerAccount.update({
          where: { id: root.id },
          data: { isActive: false },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow()
    await expect(
      prisma.ledgerAccount.update({ where: { id: root.id }, data: { name: 'Mutated assets' } }),
    ).rejects.toThrow('identity is immutable')
    await expect(prisma.ledgerAccount.delete({ where: { id: root.id } })).rejects.toThrow(
      'cannot be deleted',
    )

    const foreignParent = await prisma.ledgerAccount.findFirstOrThrow({
      where: { tenantId: tenantB, systemKey: 'ASSETS' },
    })
    await expect(
      prisma.ledgerAccount.create({
        data: {
          tenantId: tenantA,
          parentId: foreignParent.id,
          code: `A_CUSTOM_${randomUUID().slice(0, 8).toUpperCase()}`,
          name: 'Invalid cross-tenant account',
          type: 'ASSET',
        },
      }),
    ).rejects.toThrow()
  })

  it('forces RLS for bootstrap, accounts and governance history', async () => {
    const withoutContext = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "LedgerAccount"
      `
    })
    expect(withoutContext).toEqual([{ count: 0n }])

    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
      return Promise.all([
        transaction.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM "LedgerAccount"
        `,
        transaction.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM "TenantFinancialBootstrap"
        `,
      ])
    })
    expect(visible[0]).toEqual([{ count: 14n }])
    // One bootstrap row per chart version provisioned. v2 no longer provisions
    // anything, so a tenant created now has only v1's.
    expect(visible[1]).toEqual([{ count: 1n }])
  })
})
