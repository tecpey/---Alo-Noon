import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import {
  CashOnDeliveryError,
  createPrismaCashOnDeliveryService,
  type CashOnDeliveryService,
} from './modules/cash-on-delivery'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * Exercises cash on delivery against PostgreSQL.
 *
 * The rules worth testing here are the ones that only hold once several tables
 * agree: cash lands in a courier receivable rather than in the bank, an order's
 * cash can be handed in exactly once, a courier cannot hand in somebody else's
 * collections, and a count that does not match posts nothing at all.
 *
 * The ledger is the point. Every assertion about money reads the journal rather
 * than a status column, because a status column can say "paid" while the books
 * say nothing happened.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-20T09:00:00.000Z')

interface Fixture {
  tenantId: string
  cityId: string
  branchId: string
  courierId: string
  otherCourierId: string
  staffId: string
  customerId: string
}

let fixture: Fixture
let service: CashOnDeliveryService

afterAll(async () => prisma.$disconnect())

async function withTenant<T>(
  tenantId: string,
  run: (t: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return run(transaction)
  })
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `cod-${suffix.toLowerCase()}`, name: `COD ${suffix}`, status: 'ACTIVE' },
  })
  return withTenant(tenant.id, async (t) => {
    const city = await t.city.create({
      data: {
        tenantId: tenant.id,
        code: `COD${suffix}`,
        nameFa: 'شهر',
        isActive: true,
        cashOnDeliveryEnabled: true,
        cashOnDeliveryCeiling: 5_000_000n,
        cashOnDeliveryMinimumOrders: 0,
      },
    })
    const zone = await t.operationalZone.create({
      data: {
        tenantId: tenant.id,
        cityId: city.id,
        code: `CZ${suffix}`.slice(0, 16),
        nameFa: 'ناحیه',
        isActive: true,
      },
    })
    const bakery = await t.bakery.create({
      data: {
        tenantId: tenant.id,
        legalName: `Bakery ${suffix}`,
        displayNameFa: 'نانوایی',
        partnerStatus: 'ACTIVE',
      },
    })
    const branch = await t.bakeryBranch.create({
      data: {
        tenantId: tenant.id,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `CB${suffix}`.slice(0, 16),
        nameFa: 'شعبه',
        addressLine: 'نشانی',
        latitude: '36.5513',
        longitude: '52.6790',
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    const partner = await t.courierPartner.create({
      data: {
        tenantId: tenant.id,
        code: `CP${suffix}`.slice(0, 16),
        displayName: `Partner ${suffix}`,
        isActive: true,
      },
    })
    const makeCourier = (tag: string) =>
      t.courier.create({
        data: {
          tenantId: tenant.id,
          courierPartnerId: partner.id,
          mobileE164: `+9893${tag}${suffix.slice(0, 5)}`,
          displayName: `پیک ${tag}`,
          status: 'AVAILABLE',
        },
      })
    const courier = await makeCourier('1')
    const otherCourier = await makeCourier('2')
    const customer = await t.customer.create({
      data: { tenantId: tenant.id, mobileE164: `+9894${suffix.slice(0, 8)}` },
    })

    return {
      tenantId: tenant.id,
      cityId: city.id,
      branchId: branch.id,
      courierId: courier.id,
      otherCourierId: otherCourier.id,
      // An actor id, unconstrained by design: identity accounts are not
      // tenant-owned, so nothing here points at one.
      staffId: randomUUID(),
      customerId: customer.id,
    }
  })
}

/**
 * A cash order that has been delivered by a courier.
 *
 * Built directly rather than through checkout: this suite is about what
 * happens to the money after the bread arrives, and driving a full basket
 * through pricing would test the parts that already have their own tests.
 */
async function deliveredCashOrder(
  amount: bigint,
  courierId: string,
): Promise<{ orderId: string; paymentId: string }> {
  return withTenant(fixture.tenantId, async (t) => {
    const zone = await t.operationalZone.findFirstOrThrow({
      where: { tenantId: fixture.tenantId },
    })
    // One slot, shared by every order this suite makes. Capacity is not what is
    // under test here, and a slot per order would collide on (branch, date).
    const serviceDate = new Date('2026-08-20T00:00:00.000Z')
    const capacitySlot = await t.bakeryCapacitySlot.upsert({
      where: {
        bakeryBranchId_serviceDate: { bakeryBranchId: fixture.branchId, serviceDate },
      },
      update: {},
      create: {
        tenantId: fixture.tenantId,
        bakeryBranchId: fixture.branchId,
        serviceDate,
        maxOrders: 1_000,
      },
    })
    const order = await t.order.create({
      data: {
        tenantId: fixture.tenantId,
        publicId: randomUUID().slice(0, 10).toUpperCase(),
        idempotencyKey: randomUUID(),
        customerId: fixture.customerId,
        cityId: fixture.cityId,
        operationalZoneId: zone.id,
        bakeryBranchId: fixture.branchId,
        bakeryCapacitySlotId: capacitySlot.id,
        state: 'PENDING_CONFIRMATION',
        paymentState: 'NOT_STARTED',
        paymentMethod: 'CASH_ON_DELIVERY',
        recipientNameSnapshot: 'گیرنده',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: amount,
        deliveryFeeAmount: 0n,
        discountAmount: 0n,
        totalAmount: amount,
        currency: 'IRR',
      },
    })
    const fulfillment = await t.fulfillment.create({
      data: {
        tenantId: fixture.tenantId,
        orderId: order.id,
        bakeryBranchId: fixture.branchId,
        type: 'BAKERY_PICKUP_DELIVERY',
        state: 'COMPLETED',
      },
    })
    const task = await t.deliveryTask.create({
      data: { tenantId: fixture.tenantId, fulfillmentId: fulfillment.id, state: 'DELIVERED' },
    })
    await t.deliveryAssignment.create({
      data: {
        tenantId: fixture.tenantId,
        deliveryTaskId: task.id,
        courierId,
        state: 'COMPLETED',
        offeredAt: now,
        endedAt: now,
      },
    })
    const payment = await t.payment.create({
      data: {
        tenantId: fixture.tenantId,
        orderId: order.id,
        customerId: fixture.customerId,
        method: 'CASH_ON_DELIVERY',
        amount,
        currency: 'IRR',
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        transitions: {
          create: {
            tenantId: fixture.tenantId,
            fromState: null,
            toState: 'CREATED',
            actorType: 'SYSTEM',
            version: 1,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
            occurredAt: now,
          },
        },
      },
    })
    return { orderId: order.id, paymentId: payment.id }
  })
}

async function journalFor(paymentId: string, type: string) {
  return withTenant(fixture.tenantId, (t) =>
    t.financialTransaction.findFirst({
      where: { tenantId: fixture.tenantId, paymentId, type: type as 'PAYMENT_CAPTURE' },
      include: { entries: { include: { ledgerAccount: true }, orderBy: { sequence: 'asc' } } },
    }),
  )
}

databaseDescribe('cash on delivery against PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
    service = createPrismaCashOnDeliveryService(prisma, {
      ledger: createPrismaPaymentLedgerService(prisma),
    })
  })

  it('provisions the courier receivable account for a new tenant', async () => {
    const account = await withTenant(fixture.tenantId, (t) =>
      t.ledgerAccount.findFirst({
        where: { tenantId: fixture.tenantId, systemKey: 'COURIER_CASH_RECEIVABLE' },
      }),
    )
    expect(account?.code).toBe('A_1200_COURIER_CASH_RECEIVABLE')
    expect(account?.isPostable).toBe(true)
    expect(account?.templateVersion).toBe(2)
  })

  describe('what the city will allow', () => {
    it('allows an ordinary basket', async () => {
      const decision = await service.decideForOrder(fixture.tenantId, {
        cityId: fixture.cityId,
        customerId: fixture.customerId,
        orderTotal: 400_000n,
      })
      expect(decision).toEqual({ allowed: true })
    })

    it('refuses a basket over the city ceiling', async () => {
      const decision = await service.decideForOrder(fixture.tenantId, {
        cityId: fixture.cityId,
        customerId: fixture.customerId,
        orderTotal: 5_000_001n,
      })
      expect(decision).toEqual({
        allowed: false,
        reason: 'CASH_ON_DELIVERY_ABOVE_CEILING',
      })
    })

    /** A city that does not exist offers nothing rather than everything. */
    it('refuses for a city that is not there', async () => {
      const decision = await service.decideForOrder(fixture.tenantId, {
        cityId: randomUUID(),
        customerId: fixture.customerId,
        orderTotal: 100_000n,
      })
      expect(decision).toEqual({ allowed: false, reason: 'CASH_ON_DELIVERY_DISABLED' })
    })
  })

  describe('collecting at the door', () => {
    /**
     * The whole point of the feature. Money taken at a door is not money at a
     * bank, and posting it as though it were is how a delivery business
     * discovers months later that its cash position was never real.
     */
    it('debits a courier receivable, not cash clearing', async () => {
      const { orderId, paymentId } = await deliveredCashOrder(400_000n, fixture.courierId)
      const result = await service.collectForOrder(fixture.tenantId, orderId, now, randomUUID())
      expect(result).toEqual({ collected: true, reasonCode: 'CASH_COLLECTED' })

      const posting = await journalFor(paymentId, 'PAYMENT_CAPTURE')
      expect(
        posting?.entries.map((entry) => [
          entry.ledgerAccount.code,
          entry.side,
          entry.amount.toString(),
        ]),
      ).toEqual([
        ['A_1200_COURIER_CASH_RECEIVABLE', 'DEBIT', '400000'],
        ['L_2100_PAYMENT_CLEARING', 'CREDIT', '400000'],
      ])
    })

    it('marks the order paid', async () => {
      const { orderId } = await deliveredCashOrder(250_000n, fixture.courierId)
      await service.collectForOrder(fixture.tenantId, orderId, now, randomUUID())
      const order = await withTenant(fixture.tenantId, (t) =>
        t.order.findFirst({ where: { id: orderId } }),
      )
      expect(order?.paymentState).toBe('PAID')
    })

    /** A retried delivery report must not post the money twice. */
    it('is safe to call again', async () => {
      const { orderId, paymentId } = await deliveredCashOrder(150_000n, fixture.courierId)
      const first = await service.collectForOrder(fixture.tenantId, orderId, now, randomUUID())
      const second = await service.collectForOrder(fixture.tenantId, orderId, now, randomUUID())
      expect(first.collected).toBe(true)
      expect(second).toEqual({ collected: false, reasonCode: 'ALREADY_COLLECTED' })

      const postings = await withTenant(fixture.tenantId, (t) =>
        t.financialTransaction.count({ where: { paymentId, type: 'PAYMENT_CAPTURE' } }),
      )
      expect(postings).toBe(1)
    })

    it('leaves a gateway order alone', async () => {
      const { orderId } = await deliveredCashOrder(100_000n, fixture.courierId)
      await withTenant(fixture.tenantId, (t) =>
        t.order.update({ where: { id: orderId }, data: { paymentMethod: 'ONLINE_GATEWAY' } }),
      )
      expect(await service.collectForOrder(fixture.tenantId, orderId, now, randomUUID())).toEqual({
        collected: false,
        reasonCode: 'NOT_A_CASH_ORDER',
      })
    })

    /**
     * Collection happens after the delivery transaction commits, so a crash in
     * between leaves an order delivered and unpaid. The sweep is what stops
     * that becoming money nobody ever counted.
     */
    it('sweeps up an order a crash left uncollected', async () => {
      const { orderId, paymentId } = await deliveredCashOrder(320_000n, fixture.courierId)
      const swept = await service.sweep(fixture.tenantId, now, randomUUID())
      expect(swept.collected).toBeGreaterThanOrEqual(1)

      const posting = await journalFor(paymentId, 'PAYMENT_CAPTURE')
      expect(posting).not.toBeNull()
      const order = await withTenant(fixture.tenantId, (t) =>
        t.order.findFirst({ where: { id: orderId } }),
      )
      expect(order?.paymentState).toBe('PAID')
    })
  })

  describe('what the courier is carrying', () => {
    it('adds up only what has been collected and not handed in', async () => {
      const positions = await service.outstandingByCourier(fixture.tenantId)
      const carried = positions.find((position) => position.courierId === fixture.courierId)
      expect(carried).toBeDefined()
      expect(carried!.outstandingAmount).toBeGreaterThan(0n)
      expect(carried!.courierName).toBe('پیک 1')
    })
  })

  describe('handing the cash in', () => {
    it('moves the money to the bank and clears the receivable', async () => {
      const first = await deliveredCashOrder(200_000n, fixture.otherCourierId)
      const second = await deliveredCashOrder(300_000n, fixture.otherCourierId)
      for (const order of [first, second]) {
        await service.collectForOrder(fixture.tenantId, order.orderId, now, randomUUID())
      }

      const result = await service.recordRemittance(
        fixture.tenantId,
        {
          courierId: fixture.otherCourierId,
          orderIds: [first.orderId, second.orderId],
          declaredAmount: 500_000n,
          countedById: fixture.staffId,
          idempotencyKey: `remit-${randomUUID()}`,
        },
        now,
        randomUUID(),
      )
      expect(result.orderCount).toBe(2)
      expect(result.expectedAmount).toBe(500_000n)

      const posting = await journalFor(first.paymentId, 'CASH_REMITTANCE')
      expect(posting?.entries.map((entry) => [entry.ledgerAccount.code, entry.side])).toEqual([
        ['A_1100_CASH_CLEARING', 'DEBIT'],
        ['A_1200_COURIER_CASH_RECEIVABLE', 'CREDIT'],
      ])

      // The receivable nets to nothing for these two orders: collected, then
      // handed in.
      const net = await withTenant(fixture.tenantId, async (t) => {
        const entries = await t.ledgerEntry.findMany({
          where: {
            tenantId: fixture.tenantId,
            ledgerAccount: { systemKey: 'COURIER_CASH_RECEIVABLE' },
            financialTransaction: { paymentId: { in: [first.paymentId, second.paymentId] } },
          },
        })
        return entries.reduce(
          (total, entry) => total + (entry.side === 'DEBIT' ? entry.amount : -entry.amount),
          0n,
        )
      })
      expect(net).toBe(0n)

      const positions = await service.outstandingByCourier(fixture.tenantId)
      expect(positions.find((entry) => entry.courierId === fixture.otherCourierId)).toBeUndefined()
    })

    /**
     * A courier who is short has a dispute, and a dispute is a decision a
     * person makes and records. Absorbing it silently would let cash leak out
     * of the business through a hole that balances perfectly.
     */
    it('posts nothing when the count does not match', async () => {
      const order = await deliveredCashOrder(180_000n, fixture.courierId)
      await service.collectForOrder(fixture.tenantId, order.orderId, now, randomUUID())

      await expect(
        service.recordRemittance(
          fixture.tenantId,
          {
            courierId: fixture.courierId,
            orderIds: [order.orderId],
            declaredAmount: 170_000n,
            countedById: fixture.staffId,
            idempotencyKey: `short-${randomUUID()}`,
          },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(CashOnDeliveryError)

      expect(await journalFor(order.paymentId, 'CASH_REMITTANCE')).toBeNull()
      const remittances = await withTenant(fixture.tenantId, (t) =>
        t.courierCashRemittance.count({ where: { tenantId: fixture.tenantId } }),
      )
      // Only the balanced one from the test above.
      expect(remittances).toBe(1)
    })

    /** Nobody may hand in cash somebody else is carrying. */
    it('refuses an order carried by a different courier', async () => {
      const order = await deliveredCashOrder(210_000n, fixture.courierId)
      await service.collectForOrder(fixture.tenantId, order.orderId, now, randomUUID())

      await expect(
        service.recordRemittance(
          fixture.tenantId,
          {
            courierId: fixture.otherCourierId,
            orderIds: [order.orderId],
            declaredAmount: 210_000n,
            countedById: fixture.staffId,
            idempotencyKey: `wrong-${randomUUID()}`,
          },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(/REMITTANCE_COURIER_MISMATCH/)
    })

    it('refuses an order whose cash was never collected', async () => {
      const order = await deliveredCashOrder(90_000n, fixture.courierId)
      await expect(
        service.recordRemittance(
          fixture.tenantId,
          {
            courierId: fixture.courierId,
            orderIds: [order.orderId],
            declaredAmount: 90_000n,
            countedById: fixture.staffId,
            idempotencyKey: `uncollected-${randomUUID()}`,
          },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(/REMITTANCE_ORDER_NOT_COLLECTIBLE/)
    })

    /**
     * The invariant that matters when somebody is standing at a desk with a
     * bag of notes and a retry button.
     */
    it('will not let the same order be handed in twice', async () => {
      const order = await deliveredCashOrder(140_000n, fixture.courierId)
      await service.collectForOrder(fixture.tenantId, order.orderId, now, randomUUID())
      const remit = (key: string) =>
        service.recordRemittance(
          fixture.tenantId,
          {
            courierId: fixture.courierId,
            orderIds: [order.orderId],
            declaredAmount: 140_000n,
            countedById: fixture.staffId,
            idempotencyKey: key,
          },
          now,
          randomUUID(),
        )
      await remit(`twice-a-${randomUUID()}`)
      await expect(remit(`twice-b-${randomUUID()}`)).rejects.toThrow()

      const postings = await withTenant(fixture.tenantId, (t) =>
        t.financialTransaction.count({
          where: { paymentId: order.paymentId, type: 'CASH_REMITTANCE' },
        }),
      )
      expect(postings).toBe(1)
    })

    it('replays on the same key rather than posting again', async () => {
      const order = await deliveredCashOrder(260_000n, fixture.courierId)
      await service.collectForOrder(fixture.tenantId, order.orderId, now, randomUUID())
      const key = `replay-${randomUUID()}`
      const command = {
        courierId: fixture.courierId,
        orderIds: [order.orderId],
        declaredAmount: 260_000n,
        countedById: fixture.staffId,
        idempotencyKey: key,
      }
      const first = await service.recordRemittance(fixture.tenantId, command, now, randomUUID())
      const second = await service.recordRemittance(fixture.tenantId, command, now, randomUUID())
      expect(second.remittanceId).toBe(first.remittanceId)

      const postings = await withTenant(fixture.tenantId, (t) =>
        t.financialTransaction.count({
          where: { paymentId: order.paymentId, type: 'CASH_REMITTANCE' },
        }),
      )
      expect(postings).toBe(1)
    })

    it('refuses a remittance that settles nothing', async () => {
      await expect(
        service.recordRemittance(
          fixture.tenantId,
          {
            courierId: fixture.courierId,
            orderIds: [],
            declaredAmount: 1n,
            countedById: fixture.staffId,
            idempotencyKey: `empty-${randomUUID()}`,
          },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(/REMITTANCE_EMPTY/)
    })
  })

  describe('the guards the database keeps of its own', () => {
    it('refuses a city ceiling of nothing', async () => {
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.city.update({
            where: { id: fixture.cityId },
            data: { cashOnDeliveryCeiling: 0n },
          }),
        ),
      ).rejects.toThrow(/city_cash_on_delivery_policy_check/)
    })

    it('refuses a remittance worth nothing', async () => {
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.courierCashRemittance.create({
            data: {
              tenantId: fixture.tenantId,
              courierId: fixture.courierId,
              expectedAmount: 0n,
              declaredAmount: 0n,
              countedById: fixture.staffId,
              idempotencyKey: `zero-${randomUUID()}`,
              correlationId: randomUUID(),
              occurredAt: now,
            },
          }),
        ),
      ).rejects.toThrow(/courier_cash_remittance_amount_check/)
    })
  })
})
