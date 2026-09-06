import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'
import { branchContextSchema, branchOrderSummarySchema } from '@alo-noon/contracts'

import { branchScopeFromGrants } from './modules/admin-auth'
import {
  createPrismaBranchOperationsService,
  type BranchOperationsService,
} from './modules/branch-operations'
import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import {
  createPrismaOrderOperationsService,
  type OrderOperationsService,
} from './modules/order-operations'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * The wall between two bakeries in one city.
 *
 * RLS keeps one tenant out of another's rows. It does nothing here: two bakeries
 * on the same platform are the same tenant, and the only thing standing between
 * a partner's counter and its neighbour's queue is the branch filter in these
 * queries and the branch check in the order pipeline. So that is what this test
 * is about — not that the happy path works, but that the wall holds from both
 * sides: reads that must not return the neighbour's orders, and writes that must
 * not move them.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger = createPrismaPaymentLedgerService(prisma)
const branchService: BranchOperationsService = createPrismaBranchOperationsService(prisma)
const orders: OrderOperationsService = createPrismaOrderOperationsService(prisma, {
  ledgerService: ledger,
})

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-09-01T06:00:00.000Z')

interface Fixture {
  tenantId: string
  /** The counter we act as: holds BRANCH_OPERATOR on `ourBranchId` only. */
  operatorId: string
  ourBranchId: string
  rivalBranchId: string
  ourOrderId: string
  rivalOrderId: string
}

let fixture: Fixture
const actor = () => ({ accountId: fixture.operatorId, branchIds: [fixture.ourBranchId] })

afterAll(async () => prisma.$disconnect())

databaseDescribe('the bakery counter over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
  }, 120_000)

  it('names the counter it is signed in for, and only that one', async () => {
    const context = await branchService.context(fixture.tenantId, [fixture.ourBranchId])
    expect(context).toHaveLength(1)
    expect(context[0]?.branchId).toBe(fixture.ourBranchId)
    expect(branchContextSchema.safeParse(context[0]).success).toBe(true)
  })

  it('shows this branch its own queue and not the bakery next door', async () => {
    const queue = await branchService.queue(fixture.tenantId, [fixture.ourBranchId], {
      scope: 'ALL',
      limit: 50,
    })
    expect(queue.map((order) => order.id)).toEqual([fixture.ourOrderId])
    expect(branchOrderSummarySchema.safeParse(queue[0]).success).toBe(true)
    // The items are what a counter actually reads. An order with no lines is a
    // card that says nothing.
    expect(queue[0]?.items.length).toBeGreaterThan(0)
    expect(queue[0]?.itemCount).toBe(3)
  })

  it('reports the rival order as absent rather than forbidden', async () => {
    // Not 403. "That order exists but is not yours" still tells a competitor's
    // counter that it exists, and order ids are guessable enough for that to be
    // worth refusing to say.
    await expect(
      orders.accept(
        fixture.tenantId,
        actor(),
        { orderId: fixture.rivalOrderId, reason: 'سفارش نانوایی دیگر' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 })

    const untouched = await prisma.order.findFirstOrThrow({
      where: { id: fixture.rivalOrderId },
    })
    expect(untouched.state).toBe('PENDING_CONFIRMATION')
  })

  it('refuses to move the rival order production either', async () => {
    await expect(
      orders.advanceProduction(
        fixture.tenantId,
        actor(),
        { orderId: fixture.rivalOrderId, to: 'IN_PRODUCTION', reason: 'تولید سفارش دیگری' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 })
  })

  it('lets the counter run its own order all the way to the courier', async () => {
    const accepted = await orders.accept(
      fixture.tenantId,
      actor(),
      { orderId: fixture.ourOrderId, reason: 'پذیرش از پنل نانوایی' },
      now,
      randomUUID(),
    )
    expect(accepted.state).toBe('CONFIRMED')

    for (const to of ['SCHEDULED', 'IN_PRODUCTION', 'READY'] as const) {
      const moved = await orders.advanceProduction(
        fixture.tenantId,
        actor(),
        { orderId: fixture.ourOrderId, to, reason: `تولید ${to}` },
        now,
        randomUUID(),
      )
      expect(moved.productionState).toBe(to)
    }

    const handed = await orders.startFulfillment(
      fixture.tenantId,
      actor(),
      { orderId: fixture.ourOrderId, reason: 'تحویل به پیک' },
      now,
      randomUUID(),
    )
    expect(handed.state).toBe('IN_FULFILLMENT')
  })

  it('refuses an account whose branch grant was never made', async () => {
    // A branch id the caller does not hold. The permission check is against live
    // grant rows, so naming a branch is not the same as holding it.
    await expect(
      orders.accept(
        fixture.tenantId,
        { accountId: fixture.operatorId, branchIds: [fixture.rivalBranchId] },
        { orderId: fixture.rivalOrderId, reason: 'با شعبهٔ جعلی' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_OPERATION_FORBIDDEN', status: 403 })
  })

  it('reports earnings for this branch and nothing from the other', async () => {
    // Nothing has been delivered, so the honest answer is zero rather than the
    // bakery-wide figure a naive join would have produced.
    const earnings = await branchService.earnings(fixture.tenantId, [fixture.ourBranchId])
    expect(earnings.unpaid.amount).toBe('0')
    expect(earnings.paid.amount).toBe('0')
    expect(earnings.recent).toEqual([])
  })
})

describe('resolving what a session may reach', () => {
  const later = '2026-12-01T00:00:00.000Z'
  const clock = new Date('2026-09-01T06:00:00.000Z')
  const grant = (scopeType: string, scopeId: string | null, expiresAt: string | null = null) => ({
    permissions: [ADMIN_PERMISSIONS.ordersManage],
    scopeType,
    scopeId,
    expiresAt,
  })

  it('answers null for a tenant-wide grant, which means no branch filter', () => {
    expect(
      branchScopeFromGrants([grant('GLOBAL', null)], ADMIN_PERMISSIONS.ordersManage, clock),
    ).toBeNull()
  })

  it('answers the branches for a partner, de-duplicated', () => {
    expect(
      branchScopeFromGrants(
        [grant('BAKERY_BRANCH', 'b1'), grant('BAKERY_BRANCH', 'b2'), grant('BAKERY_BRANCH', 'b1')],
        ADMIN_PERMISSIONS.ordersManage,
        clock,
      ),
    ).toEqual(['b1', 'b2'])
  })

  it('answers an empty list — never null — when nothing qualifies', () => {
    // The distinction is the whole point. Null means "unfiltered"; a caller that
    // treated "no grant" as null would hand an unprivileged session the tenant.
    expect(
      branchScopeFromGrants(
        [
          {
            permissions: ['session.self.read'],
            scopeType: 'GLOBAL',
            scopeId: null,
            expiresAt: null,
          },
        ],
        ADMIN_PERMISSIONS.ordersManage,
        clock,
      ),
    ).toEqual([])
    expect(
      branchScopeFromGrants(
        [grant('BAKERY_BRANCH', 'b1', '2026-08-01T00:00:00.000Z')],
        ADMIN_PERMISSIONS.ordersManage,
        clock,
      ),
    ).toEqual([])
  })

  it('keeps a grant that has not expired yet', () => {
    expect(
      branchScopeFromGrants(
        [grant('BAKERY_BRANCH', 'b1', later)],
        ADMIN_PERMISSIONS.ordersManage,
        clock,
      ),
    ).toEqual(['b1'])
  })
})

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `brn-${suffix.toLowerCase()}`, name: `Branch ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `BRN-${suffix}`, nameFa: 'شهر شعبه', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `BRNZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })

  const makeBranch = async (tag: string, nameFa: string): Promise<string> => {
    const bakery = await prisma.bakery.create({
      data: {
        tenantId,
        legalName: `Bakery ${tag} ${suffix}`,
        displayNameFa: nameFa,
        partnerStatus: 'ACTIVE',
        commissionBasisPoints: 1500,
      },
    })
    const branch = await prisma.bakeryBranch.create({
      data: {
        tenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `BRNB-${tag}-${suffix}`,
        nameFa,
        addressLine: 'نشانی',
        latitude: '36.5442',
        longitude: '52.6781',
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    return branch.id
  }

  const ourBranchId = await makeBranch('OURS', 'نانوایی ما')
  const rivalBranchId = await makeBranch('RIVAL', 'نانوایی روبه‌رو')
  const customer = await prisma.customer.create({ data: { tenantId, mobileE164: uniqueMobile() } })

  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `brn-provision-${suffix}` },
    now,
    randomUUID(),
  )

  const [product, variant, offering] = await catalogue(tenantId, ourBranchId)

  const order = async (key: string, branchId: string, withItems: boolean): Promise<string> => {
    const created = await prisma.order.create({
      data: {
        tenantId,
        idempotencyKey: key,
        customerId: customer.id,
        bakeryBranchId: branchId,
        cityId: city.id,
        operationalZoneId: zone.id,
        state: 'PENDING_CONFIRMATION',
        recipientNameSnapshot: 'گیرنده',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: 180_000n,
        deliveryFeeAmount: 0n,
        discountAmount: 0n,
        totalAmount: 180_000n,
        createdAt: now,
        updatedAt: now,
      },
    })
    if (withItems) {
      await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: created.id,
          productVariantId: variant,
          bakeryProductOfferingId: offering,
          skuSnapshot: `SKU-${suffix}`,
          productNameFaSnapshot: 'نان سنگک',
          variantNameFaSnapshot: 'ساده',
          fulfillmentClassSnapshot: 'SIGNATURE_FRESH',
          freshnessClaimSnapshot: 'FRESHLY_PRODUCED',
          quantity: 3,
          unitPriceAmount: 60_000n,
          lineTotalAmount: 180_000n,
        },
      })
    }

    const payment = await ledger.initialize(
      tenantId,
      customer.id,
      { orderId: created.id, idempotencyKey: `brn-init-${key}` },
      now,
      randomUUID(),
    )
    for (const to of ['PENDING', 'AUTHORIZED'] as const) {
      await ledger.transition(
        tenantId,
        { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: `brn-${to}-${key}` },
        now,
        randomUUID(),
      )
    }
    await ledger.capture(
      tenantId,
      {
        paymentId: payment.id,
        idempotencyKey: `brn-capture-${key}`,
        entries: [
          { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: 180_000n },
          { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: 180_000n },
        ],
      },
      now,
      randomUUID(),
    )
    return created.id
  }

  // Granted on our branch only. The rival branch is deliberately not granted:
  // the whole test is what that absence prevents.
  const operatorId = await createAccount(tenantId, ourBranchId, [
    ADMIN_PERMISSIONS.ordersRead,
    ADMIN_PERMISSIONS.ordersManage,
  ])

  void product
  return {
    tenantId,
    operatorId,
    ourBranchId,
    rivalBranchId,
    ourOrderId: await order(`brn-${suffix}-ours`, ourBranchId, true),
    rivalOrderId: await order(`brn-${suffix}-rival`, rivalBranchId, false),
  }
}

/** The smallest catalogue an order line can legally point at. */
async function catalogue(tenantId: string, branchId: string): Promise<[string, string, string]> {
  const category = await prisma.productCategory.create({
    data: { tenantId, code: `BRNC-${suffix}`, nameFa: 'نان' },
  })
  const product = await prisma.product.create({
    data: {
      tenantId,
      categoryId: category.id,
      slug: `brn-bread-${suffix.toLowerCase()}`,
      nameFa: 'نان سنگک',
      lifecycle: 'ACTIVE',
    },
  })
  const variant = await prisma.productVariant.create({
    data: {
      tenantId,
      productId: product.id,
      sku: `SKU-${suffix}`,
      nameFa: 'ساده',
      fulfillmentClass: 'SIGNATURE_FRESH',
      freshnessClaim: 'FRESHLY_PRODUCED',
      productionMode: 'MADE_TO_ORDER',
      fulfillmentControl: 'CONTROLLED_PICKUP',
      lifecycle: 'ACTIVE',
    },
  })
  const offering = await prisma.bakeryProductOffering.create({
    data: {
      tenantId,
      bakeryBranchId: branchId,
      productVariantId: variant.id,
      priceAmount: 60_000n,
      availability: 'AVAILABLE',
    },
  })
  return [product.id, variant.id, offering.id]
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '8').slice(0, 9)}`
}

/** An account holding a role against exactly one branch. */
async function createAccount(
  tenantId: string,
  branchId: string,
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

  const role = await prisma.authorizationRole.upsert({
    where: { code: `BRANCH_OPERATOR_${suffix}` },
    update: {},
    create: { code: `BRANCH_OPERATOR_${suffix}`, name: 'Branch operator' },
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
    data: {
      accountId: account.id,
      roleId: role.id,
      scopeType: 'BAKERY_BRANCH',
      scopeId: branchId,
      activeAt: now,
    },
  })
  return account.id
}
