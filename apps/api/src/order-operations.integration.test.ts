import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  createPrismaOrderOperationsService,
  type OrderOperationsService,
} from './modules/order-operations'
import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * An order's life after payment, against PostgreSQL.
 *
 * The rules worth exercising are the ones that only hold when several rows
 * agree: an unpaid order is not accepted, production does not move before
 * acceptance or after the end, and two operators working the same queue cannot
 * both take the same step.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: OrderOperationsService = createPrismaOrderOperationsService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')

interface Fixture {
  tenantId: string
  operatorId: string
  outsiderId: string
  paidOrderId: string
  unpaidOrderId: string
}

let fixture: Fixture
const actor = () => ({ accountId: fixture.operatorId })

afterAll(async () => prisma.$disconnect())

databaseDescribe('order operations over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('refuses an operator without the orders permission', async () => {
    await expect(
      service.accept(
        fixture.tenantId,
        { accountId: fixture.outsiderId },
        { orderId: fixture.paidOrderId, reason: 'بدون دسترسی' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_OPERATION_FORBIDDEN', status: 403 })
  })

  it('refuses to accept an order nobody has paid for', async () => {
    // Accepting commits a bakery to bake bread. Doing that before the money
    // arrived is the mistake this rule exists to prevent.
    await expect(
      service.accept(
        fixture.tenantId,
        actor(),
        { orderId: fixture.unpaidOrderId, reason: 'پذیرش زودهنگام' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_PAID', status: 409 })
  })

  it('rejects an unpaid order without requiring payment first', async () => {
    // The unpaid case is exactly the one that needs rejecting.
    const rejected = await service.reject(
      fixture.tenantId,
      actor(),
      { orderId: fixture.unpaidOrderId, reason: 'نانوایی امروز تعطیل است' },
      now,
      randomUUID(),
    )
    expect(rejected.state).toBe('CANCELLED')
  })

  it('refuses to move production before the order is accepted', async () => {
    await expect(
      service.advanceProduction(
        fixture.tenantId,
        actor(),
        { orderId: fixture.paidOrderId, to: 'SCHEDULED', reason: 'زودتر از پذیرش' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRODUCTION_NOT_APPLICABLE', status: 409 })
  })

  it('walks a paid order from acceptance to completion, recording each step', async () => {
    const accepted = await service.accept(
      fixture.tenantId,
      actor(),
      { orderId: fixture.paidOrderId, reason: 'پذیرش نانوایی' },
      now,
      randomUUID(),
    )
    expect(accepted.state).toBe('CONFIRMED')

    for (const to of ['SCHEDULED', 'IN_PRODUCTION', 'READY'] as const) {
      const moved = await service.advanceProduction(
        fixture.tenantId,
        actor(),
        { orderId: fixture.paidOrderId, to, reason: `پیشروی تولید به ${to}` },
        now,
        randomUUID(),
      )
      expect(moved.productionState).toBe(to)
    }

    const fulfilling = await service.startFulfillment(
      fixture.tenantId,
      actor(),
      { orderId: fixture.paidOrderId, reason: 'تحویل به پیک' },
      now,
      randomUUID(),
    )
    expect(fulfilling.state).toBe('IN_FULFILLMENT')

    // Hand-off is a production fact, and it is still available once the order
    // itself has moved on to fulfillment.
    const handed = await service.advanceProduction(
      fixture.tenantId,
      actor(),
      { orderId: fixture.paidOrderId, to: 'HANDED_OFF', reason: 'تحویل به پیک' },
      now,
      randomUUID(),
    )
    expect(handed.productionState).toBe('HANDED_OFF')

    const completed = await service.complete(
      fixture.tenantId,
      actor(),
      { orderId: fixture.paidOrderId, reason: 'تحویل شد' },
      now,
      randomUUID(),
    )
    expect(completed.state).toBe('COMPLETED')

    const transitions = await prisma.orderStateTransition.findMany({
      where: { orderId: fixture.paidOrderId },
      orderBy: { occurredAt: 'asc' },
    })
    expect(transitions.map((row) => row.toState)).toEqual([
      'CONFIRMED',
      'IN_FULFILLMENT',
      'COMPLETED',
    ])
    expect(transitions.every((row) => row.actorId === fixture.operatorId)).toBe(true)

    const audits = await prisma.auditEvent.count({
      where: { entityId: fixture.paidOrderId, entityType: 'order' },
    })
    // Three order steps plus four production steps, each audited.
    expect(audits).toBe(7)
  })

  it('refuses a step the order has already taken', async () => {
    // The transition key is derived from the order and its destination, so the
    // same step arriving twice collides rather than recording itself twice.
    await expect(
      service.complete(
        fixture.tenantId,
        actor(),
        { orderId: fixture.paidOrderId, reason: 'دوباره' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' })
  })

  it('refuses production once the order is finished', async () => {
    await expect(
      service.advanceProduction(
        fixture.tenantId,
        actor(),
        { orderId: fixture.paidOrderId, to: 'READY', reason: 'پس از پایان' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRODUCTION_NOT_APPLICABLE' })
  })

  it('reports an order from another tenant as absent', async () => {
    const other = await prisma.tenant.create({
      data: { slug: `ops-other-${suffix.toLowerCase()}`, name: `Ops other ${suffix}` },
    })
    await expect(
      service.accept(
        other.id,
        actor(),
        { orderId: fixture.paidOrderId, reason: 'از tenant دیگر' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_OPERATION_FORBIDDEN' })
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `ops-${suffix.toLowerCase()}`, name: `Ops ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `OPS-${suffix}`, nameFa: 'شهر عملیات', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `OPSZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Ops Bakery ${suffix}`,
      displayNameFa: 'نانوایی عملیات',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `OPSB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: uniqueMobile() },
  })

  // Capture posts into the tenant's chart, so the chart has to exist.
  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `ops-provision-${suffix}` },
    now,
    randomUUID(),
  )

  const order = async (key: string, paid: boolean): Promise<string> => {
    const created = await prisma.order.create({
      data: {
        tenantId,
        idempotencyKey: key,
        customerId: customer.id,
        bakeryBranchId: branch.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        state: 'PENDING_CONFIRMATION',
        recipientNameSnapshot: 'گیرنده',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی عملیات',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: 250_000n,
        deliveryFeeAmount: 0n,
        discountAmount: 0n,
        totalAmount: 250_000n,
        createdAt: now,
        updatedAt: now,
      },
    })
    if (!paid) return created.id

    // Paid for real, through the ledger. A trigger refuses an order marked PAID
    // without exactly one captured transaction behind it, so there is no
    // shortcut here — and going the real way means acceptance is tested against
    // the state capture actually leaves.
    const ledger = createPrismaPaymentLedgerService(prisma)
    const payment = await ledger.initialize(
      tenantId,
      customer.id,
      { orderId: created.id, idempotencyKey: `ops-init-${key}` },
      now,
      randomUUID(),
    )
    for (const to of ['PENDING', 'AUTHORIZED'] as const) {
      await ledger.transition(
        tenantId,
        {
          paymentId: payment.id,
          to,
          actor: 'SYSTEM',
          idempotencyKey: `ops-${to.toLowerCase()}-${key}`,
        },
        now,
        randomUUID(),
      )
    }
    await ledger.capture(
      tenantId,
      {
        paymentId: payment.id,
        idempotencyKey: `ops-capture-${key}`,
        entries: [
          { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: 250_000n },
          { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: 250_000n },
        ],
      },
      now,
      randomUUID(),
    )
    return created.id
  }

  const operatorId = await createAccount(tenantId, 'ORDER_OPERATOR', [
    ADMIN_PERMISSIONS.ordersRead,
    ADMIN_PERMISSIONS.ordersManage,
  ])
  const outsiderId = await createAccount(tenantId, null, [])

  return {
    tenantId,
    operatorId,
    outsiderId,
    paidOrderId: await order(`ops-${suffix}-paid`, true),
    unpaidOrderId: await order(`ops-${suffix}-unpaid`, false),
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '8').slice(0, 9)}`
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
    where: { code: `${roleCode}_${suffix}` },
    update: {},
    create: { code: `${roleCode}_${suffix}`, name: roleCode },
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
