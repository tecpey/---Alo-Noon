import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantA = randomUUID()
const tenantB = randomUUID()
const customerA = randomUUID()
const customerB = randomUUID()
const roleName = `alo_noon_rls_${randomUUID().replaceAll('-', '')}`

databaseDescribe('PostgreSQL tenant isolation G5', () => {
  beforeAll(async () => {
    await prisma.tenant.createMany({
      data: [
        {
          id: tenantA,
          slug: `rls-a-${tenantA.slice(0, 8)}`,
          name: 'RLS tenant A',
        },
        {
          id: tenantB,
          slug: `rls-b-${tenantB.slice(0, 8)}`,
          name: 'RLS tenant B',
        },
      ],
    })
    await prisma.customer.createMany({
      data: [
        {
          id: customerA,
          tenantId: tenantA,
          mobileE164: `+98${tenantA.replace(/\D/g, '').padEnd(10, '1').slice(0, 10)}`,
        },
        {
          id: customerB,
          tenantId: tenantB,
          mobileE164: `+98${tenantB.replace(/\D/g, '').padEnd(10, '2').slice(0, 10)}`,
        },
      ],
    })
    await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Customer" TO "${roleName}"`,
    )
  })

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: { id: { in: [customerA, customerB] } },
    })
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    })
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
    await prisma.$disconnect()
  })

  it('returns no tenant rows when database context is missing', async () => {
    const rows = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Customer"`
    })
    expect(rows).toEqual([])
  })

  it('shows only the selected tenant and rejects cross-tenant writes', async () => {
    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
      return transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Customer"`
    })
    expect(visible).toEqual([{ id: customerA }])

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
        await transaction.$executeRaw`
          INSERT INTO "Customer" ("id", "tenantId", "mobileE164", "lifecycleStatus", "createdAt", "updatedAt")
          VALUES (${randomUUID()}::uuid, ${tenantB}::uuid, '+989000000001', 'ACTIVE', now(), now())
        `
      }),
    ).rejects.toThrow()
  })
})
