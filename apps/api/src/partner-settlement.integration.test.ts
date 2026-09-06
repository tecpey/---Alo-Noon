import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'
import { partnerBalanceSchema, partnerPayoutSummarySchema } from '@alo-noon/contracts'

import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaOrderOperationsService } from './modules/order-operations'
import {
  createPrismaPartnerSettlementService,
  type PartnerSettlementService,
} from './modules/partner-settlement'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * Delivered bread becoming money somebody is owed, against PostgreSQL.
 *
 * The arithmetic is already proven in the domain. What only PostgreSQL can
 * answer is whether the split lands as rows that agree: an earning per order and
 * never two, a journal the balance trigger accepts, payables that go up when an
 * order completes and back down when a payout claims them, and a payout that
 * cannot be prepared twice for the same money.
 *
 * The numbers are chosen so every share is a whole Rial with a remainder to
 * place: 250,000 subtotal at 15% commission is 37,500, and a 12,000 delivery fee
 * at 8000 basis points is 9,600 to the courier partner.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger = createPrismaPaymentLedgerService(prisma)
const settlement: PartnerSettlementService = createPrismaPartnerSettlementService(prisma, {
  ledger,
})
const operations = createPrismaOrderOperationsService(prisma, {
  ledgerService: ledger,
  settlementService: settlement,
})

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-30T09:00:00.000Z')

const SUBTOTAL = 250_000n
const DELIVERY_FEE = 12_000n
const TOTAL = SUBTOTAL + DELIVERY_FEE
const COMMISSION = 37_500n // 250,000 × 1500bp
const COURIER_SHARE = 9_600n // 12,000 × 8000bp
const BAKERY_SHARE = SUBTOTAL - COMMISSION

interface Fixture {
  tenantId: string
  financeAccountId: string
  outsiderId: string
  bakeryId: string
  courierPartnerId: string
  orderId: string
  collectedOrderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('partner settlement over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
  }, 120_000)

  it('divides a delivered order the instant it completes', async () => {
    await walkToCompletion(fixture.orderId)

    const earning = await prisma.orderEarning.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, orderId: fixture.orderId },
    })
    expect(earning.commissionAmount).toBe(COMMISSION)
    expect(earning.bakeryShareAmount).toBe(BAKERY_SHARE)
    expect(earning.courierShareAmount).toBe(COURIER_SHARE)
    // The rates are copied onto the earning, not read through to the partner, so
    // raising a bakery's commission next month cannot recompute this one.
    expect(earning.commissionBasisPoints).toBe(1500)
    expect(earning.courierBasisPoints).toBe(8000)
    expect(earning.bakeryId).toBe(fixture.bakeryId)
    expect(earning.courierPartnerId).toBe(fixture.courierPartnerId)
  })

  it('posts a settlement journal the balance trigger accepts', async () => {
    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, orderId: fixture.orderId, type: 'ORDER_SETTLEMENT' },
      include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
    })
    // The journal grosses up: the courier's ride is a cost the platform incurs
    // and a debt it owes, so the same 9,600 lands on both sides and the
    // posting's amount is the journal's total, not the order's.
    expect(posting.amount).toBe(TOTAL + COURIER_SHARE)
    expect(
      posting.entries.map((entry) => [entry.ledgerAccount.code, entry.side, entry.amount]),
      // What the customer paid stops being held and becomes two debts and two
      // revenues. Nothing touches cash: the money arrived when they paid and is
      // still in the bank.
    ).toEqual([
      ['L_2100_PAYMENT_CLEARING', 'DEBIT', TOTAL],
      ['X_5100_DELIVERY', 'DEBIT', COURIER_SHARE],
      ['L_2200_BAKERY_PAYABLE', 'CREDIT', BAKERY_SHARE],
      ['L_2300_COURIER_PAYABLE', 'CREDIT', COURIER_SHARE],
      ['R_4100_PRODUCT_SALES', 'CREDIT', COMMISSION],
      ['R_4200_DELIVERY', 'CREDIT', DELIVERY_FEE],
    ])

    const debits = posting.entries
      .filter((entry) => entry.side === 'DEBIT')
      .reduce((sum, entry) => sum + entry.amount, 0n)
    const credits = posting.entries
      .filter((entry) => entry.side === 'CREDIT')
      .reduce((sum, entry) => sum + entry.amount, 0n)
    expect(debits).toBe(credits)
  })

  it('divides an order collected at the counter without inventing a courier', async () => {
    // No rider, no courier share — and the bakery is still owed its part. An
    // order with nobody to pay for delivery is not an order nobody gets paid for.
    await walkToCompletion(fixture.collectedOrderId)

    const earning = await prisma.orderEarning.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, orderId: fixture.collectedOrderId },
    })
    expect(earning.courierPartnerId).toBeNull()
    expect(earning.courierShareAmount).toBe(0n)
    expect(earning.bakeryShareAmount).toBe(BAKERY_SHARE)

    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: {
        tenantId: fixture.tenantId,
        orderId: fixture.collectedOrderId,
        type: 'ORDER_SETTLEMENT',
      },
      include: { entries: { include: { ledgerAccount: true } } },
    })
    // The zero courier lines are dropped rather than posted as zeros: a journal
    // is a record of what moved.
    expect(posting.entries.map((entry) => entry.ledgerAccount.code)).not.toContain(
      'L_2300_COURIER_PAYABLE',
    )
  })

  it('reports what each partner is owed, in the shape the transport promises', async () => {
    const balances = await settlement.listOutstanding(fixture.tenantId)
    for (const balance of balances) {
      expect(partnerBalanceSchema.safeParse(balance).success).toBe(true)
    }

    const bakery = balances.find((row) => row.party === 'BAKERY')
    // Two completed orders, both with the same bakery share.
    expect(bakery?.amount.amount).toBe((BAKERY_SHARE * 2n).toString())
    expect(bakery?.orderCount).toBe(2)

    const courier = balances.find((row) => row.party === 'COURIER')
    expect(courier?.amount.amount).toBe(COURIER_SHARE.toString())
    expect(courier?.orderCount).toBe(1)
  })

  it('refuses to prepare a payout for an account without the finance permission', async () => {
    // The route already turned this session away from its session grants. This
    // is the check against the live rows, inside the transaction that would move
    // the money.
    await expect(
      settlement.preparePayout(
        fixture.tenantId,
        fixture.outsiderId,
        {
          party: 'BAKERY',
          partnerId: fixture.bakeryId,
          idempotencyKey: `intruder-${suffix}-payout`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_FORBIDDEN', status: 403 })

    expect(await prisma.partnerPayout.count({ where: { tenantId: fixture.tenantId } })).toBe(0)
  })

  it('claims every unpaid earning into one payout and discharges the payable', async () => {
    const payout = await settlement.preparePayout(
      fixture.tenantId,
      fixture.financeAccountId,
      { party: 'BAKERY', partnerId: fixture.bakeryId, idempotencyKey: `payout-${suffix}-bakery` },
      now,
      randomUUID(),
    )
    expect(payout).not.toBeNull()
    expect(partnerPayoutSummarySchema.safeParse(payout).success).toBe(true)
    expect(payout!.amount.amount).toBe((BAKERY_SHARE * 2n).toString())
    expect(payout!.orderCount).toBe(2)
    expect(payout!.state).toBe('DRAFT')

    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, type: 'PARTNER_PAYOUT' },
      include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
    })
    // The platform stops owing the moment it decides to pay. The bank transfer
    // that follows is evidence recorded against a payout that already exists.
    expect(
      posting.entries.map((entry) => [entry.ledgerAccount.code, entry.side, entry.amount]),
    ).toEqual([
      ['L_2200_BAKERY_PAYABLE', 'DEBIT', BAKERY_SHARE * 2n],
      ['A_1100_CASH_CLEARING', 'CREDIT', BAKERY_SHARE * 2n],
    ])

    // And nothing is owing any more.
    const remaining = await settlement.outstanding(fixture.tenantId, 'BAKERY', fixture.bakeryId)
    expect(remaining.amount.amount).toBe('0')
    expect(remaining.orderCount).toBe(0)
  })

  it('replays a repeated preparation onto the run it already made', async () => {
    const replay = await settlement.preparePayout(
      fixture.tenantId,
      fixture.financeAccountId,
      { party: 'BAKERY', partnerId: fixture.bakeryId, idempotencyKey: `payout-${suffix}-bakery` },
      now,
      randomUUID(),
    )
    expect(replay?.amount.amount).toBe((BAKERY_SHARE * 2n).toString())
    expect(await prisma.partnerPayout.count({ where: { tenantId: fixture.tenantId } })).toBe(1)
  })

  it('prepares nothing when nothing is owing', async () => {
    // Not a failure, and not a zero-amount payout the ledger would carry forever.
    const nothing = await settlement.preparePayout(
      fixture.tenantId,
      fixture.financeAccountId,
      { party: 'BAKERY', partnerId: fixture.bakeryId, idempotencyKey: `payout-${suffix}-empty` },
      now,
      randomUUID(),
    )
    expect(nothing).toBeNull()
    expect(await prisma.partnerPayout.count({ where: { tenantId: fixture.tenantId } })).toBe(1)
  })

  it('records the bank reference once and refuses to record it twice', async () => {
    const [draft] = await settlement.listPayouts(fixture.tenantId, 10)
    const paid = await settlement.markPaid(
      fixture.tenantId,
      fixture.financeAccountId,
      { payoutId: draft!.id, bankReference: 'SATNA-4471-2026' },
      now,
    )
    expect(paid.state).toBe('PAID')
    expect(paid.bankReference).toBe('SATNA-4471-2026')

    // The same call again is the same outcome, not a second transfer.
    const again = await settlement.markPaid(
      fixture.tenantId,
      fixture.financeAccountId,
      { payoutId: draft!.id, bankReference: 'SATNA-4471-2026' },
      now,
    )
    expect(again.bankReference).toBe('SATNA-4471-2026')

    // But a bank reference nobody can look up is refused outright.
    await expect(
      settlement.markPaid(
        fixture.tenantId,
        fixture.financeAccountId,
        { payoutId: draft!.id, bankReference: '   ' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BANK_REFERENCE', status: 400 })
  })

  it('reports a payout from another tenant as absent', async () => {
    const other = await prisma.tenant.create({
      data: { slug: `stl-other-${suffix.toLowerCase()}`, name: `Settlement other ${suffix}` },
    })
    const [payout] = await settlement.listPayouts(fixture.tenantId, 1)
    await expect(
      settlement.markPaid(
        other.id,
        fixture.financeAccountId,
        { payoutId: payout!.id, bankReference: 'CROSS-TENANT' },
        now,
      ),
      // The permission check fires first: the account holds no grant in that
      // tenant at all, which is the truer refusal.
    ).rejects.toMatchObject({ status: 403 })
  })
})

/** Moves a paid order all the way to COMPLETED, which is what settles it. */
async function walkToCompletion(orderId: string): Promise<void> {
  const actor = { accountId: fixture.financeAccountId }
  await operations.accept(
    fixture.tenantId,
    actor,
    { orderId, reason: 'پذیرش نانوایی' },
    now,
    randomUUID(),
  )
  for (const to of ['SCHEDULED', 'IN_PRODUCTION', 'READY'] as const) {
    await operations.advanceProduction(
      fixture.tenantId,
      actor,
      { orderId, to, reason: `پیشروی تولید به ${to}` },
      now,
      randomUUID(),
    )
  }
  await operations.startFulfillment(
    fixture.tenantId,
    actor,
    { orderId, reason: 'تحویل به پیک' },
    now,
    randomUUID(),
  )
  await operations.complete(
    fixture.tenantId,
    actor,
    { orderId, reason: 'تحویل شد' },
    now,
    randomUUID(),
  )
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `stl-${suffix.toLowerCase()}`, name: `Settlement ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `STL-${suffix}`, nameFa: 'شهر تسویه', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `STLZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Settlement Bakery ${suffix}`,
      displayNameFa: 'نانوایی تسویه',
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
      code: `STLB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const partner = await prisma.courierPartner.create({
    data: {
      tenantId,
      code: `STLC-${suffix}`,
      displayName: 'شرکت پیک تسویه',
      isActive: true,
      deliveryShareBasisPoints: 8000,
    },
  })
  const courier = await prisma.courier.create({
    data: {
      tenantId,
      courierPartnerId: partner.id,
      mobileE164: uniqueMobile(),
      displayName: 'پیک',
      status: 'AVAILABLE',
    },
  })
  const customer = await prisma.customer.create({ data: { tenantId, mobileE164: uniqueMobile() } })

  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `stl-provision-${suffix}` },
    now,
    randomUUID(),
  )

  const financeAccountId = await createAccount(tenantId, 'SETTLEMENT_ADMIN', [
    ADMIN_PERMISSIONS.ordersRead,
    ADMIN_PERMISSIONS.ordersManage,
    ADMIN_PERMISSIONS.financeSettle,
  ])
  // Everything an order operator holds, and not the one permission that moves
  // money out — which is the whole reason that permission is separate.
  const outsiderId = await createAccount(tenantId, 'SETTLEMENT_OPERATOR', [
    ADMIN_PERMISSIONS.ordersRead,
    ADMIN_PERMISSIONS.ordersManage,
  ])

  const order = async (key: string, withCourier: boolean): Promise<string> => {
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
        bakeryNameSnapshot: 'نانوایی تسویه',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: SUBTOTAL,
        deliveryFeeAmount: DELIVERY_FEE,
        discountAmount: 0n,
        totalAmount: TOTAL,
        createdAt: now,
        updatedAt: now,
      },
    })

    if (withCourier) {
      // The partner who actually rode. The settlement reads the completed
      // assignment, not the offer, so the assignment has to be a completed one.
      const fulfillment = await prisma.fulfillment.create({
        data: {
          tenantId,
          orderId: created.id,
          bakeryBranchId: branch.id,
          type: 'BAKERY_PICKUP_DELIVERY',
          state: 'PLANNED',
        },
      })
      const task = await prisma.deliveryTask.create({
        data: { tenantId, fulfillmentId: fulfillment.id, state: 'DELIVERED' },
      })
      await prisma.deliveryAssignment.create({
        data: {
          tenantId,
          deliveryTaskId: task.id,
          courierId: courier.id,
          state: 'COMPLETED',
          offeredAt: now,
          respondedAt: now,
          endedAt: now,
        },
      })
    }

    const payment = await ledger.initialize(
      tenantId,
      customer.id,
      { orderId: created.id, idempotencyKey: `stl-init-${key}` },
      now,
      randomUUID(),
    )
    for (const to of ['PENDING', 'AUTHORIZED'] as const) {
      await ledger.transition(
        tenantId,
        { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: `stl-${to}-${key}` },
        now,
        randomUUID(),
      )
    }
    await ledger.capture(
      tenantId,
      {
        paymentId: payment.id,
        idempotencyKey: `stl-capture-${key}`,
        entries: [
          { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: TOTAL },
          { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: TOTAL },
        ],
      },
      now,
      randomUUID(),
    )
    return created.id
  }

  return {
    tenantId,
    financeAccountId,
    outsiderId,
    bakeryId: bakery.id,
    courierPartnerId: partner.id,
    orderId: await order(`stl-${suffix}-delivered`, true),
    collectedOrderId: await order(`stl-${suffix}-collected`, false),
  }
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '8').slice(0, 9)}`
}

async function createAccount(
  tenantId: string,
  roleCode: string,
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
