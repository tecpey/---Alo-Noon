import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import {
  EngagementError,
  createPrismaEngagementService,
  type EngagementService,
} from './modules/engagement'

/**
 * Exercises reorder, ratings and favourites against PostgreSQL.
 *
 * The rules worth testing here are the ones that only hold once several tables
 * agree: a reorder is priced at today's prices and drops what is gone, a rating
 * belongs to the customer whose order it was, and a branch is never flagged on
 * too few opinions.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-20T09:00:00.000Z')

interface Fixture {
  tenantId: string
  cityId: string
  zoneId: string
  branchId: string
  customerId: string
  otherCustomerId: string
  sangakId: string
  barbariId: string
  soldOutId: string
}

let fixture: Fixture
let service: EngagementService

afterAll(async () => prisma.$disconnect())

async function withTenant<T>(
  tenantId: string,
  run: (t: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const result = await run(transaction)
    // Prisma 5 resolves an interactive transaction callback even when a
    // deferred constraint then rejects COMMIT, which turns a rolled-back
    // fixture into a test that fails somewhere else entirely.
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    return result
  })
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `eng-${suffix.toLowerCase()}`, name: `Engagement ${suffix}`, status: 'ACTIVE' },
  })
  return withTenant(tenant.id, async (t) => {
    const city = await t.city.create({
      data: { tenantId: tenant.id, code: `ENG${suffix}`, nameFa: 'شهر', isActive: true },
    })
    const zone = await t.operationalZone.create({
      data: {
        tenantId: tenant.id,
        cityId: city.id,
        code: `EZ${suffix}`.slice(0, 16),
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
        code: `EB${suffix}`.slice(0, 16),
        nameFa: 'شعبه',
        addressLine: 'نشانی',
        latitude: '36.5513',
        longitude: '52.6790',
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    const category = await t.productCategory.create({
      data: { tenantId: tenant.id, code: `EC${suffix}`.slice(0, 16), nameFa: 'نان' },
    })

    const makeOffering = async (tag: string, nameFa: string, price: bigint, available: boolean) => {
      const product = await t.product.create({
        data: {
          tenantId: tenant.id,
          categoryId: category.id,
          slug: `${tag}-${suffix.toLowerCase()}`,
          nameFa,
          lifecycle: 'ACTIVE',
        },
      })
      const variant = await t.productVariant.create({
        data: {
          tenantId: tenant.id,
          productId: product.id,
          sku: `${tag}${suffix}`.slice(0, 32),
          nameFa,
          fulfillmentClass: 'SIGNATURE_FRESH',
          freshnessClaim: 'FRESHLY_PRODUCED',
          productionMode: 'MADE_TO_ORDER',
          fulfillmentControl: 'CONTROLLED_PICKUP',
          lifecycle: 'ACTIVE',
        },
      })
      return t.bakeryProductOffering.create({
        data: {
          tenantId: tenant.id,
          bakeryBranchId: branch.id,
          productVariantId: variant.id,
          priceAmount: price,
          availability: available ? 'AVAILABLE' : 'SOLD_OUT',
        },
      })
    }

    const sangak = await makeOffering('sangak', 'سنگک', 95_000n, true)
    const barbari = await makeOffering('barbari', 'بربری', 60_000n, true)
    const soldOut = await makeOffering('komaj', 'کماج', 40_000n, false)

    const makeCustomer = (tag: string) =>
      t.customer.create({
        data: { tenantId: tenant.id, mobileE164: `+9895${tag}${suffix.slice(0, 5)}` },
      })

    return {
      tenantId: tenant.id,
      cityId: city.id,
      zoneId: zone.id,
      branchId: branch.id,
      customerId: (await makeCustomer('1')).id,
      otherCustomerId: (await makeCustomer('2')).id,
      sangakId: sangak.id,
      barbariId: barbari.id,
      soldOutId: soldOut.id,
    }
  })
}

/**
 * A completed order with the given lines.
 *
 * Prices are deliberately written *stale* — half of today's — so a reorder that
 * copied them instead of re-reading would be visible.
 */
async function completedOrder(
  customerId: string,
  lines: readonly { offeringId: string; quantity: number; nameFa: string }[],
  options: { completedAt?: Date; state?: string } = {},
): Promise<string> {
  return withTenant(fixture.tenantId, async (t) => {
    const serviceDate = new Date('2026-08-20T00:00:00.000Z')
    const slot = await t.bakeryCapacitySlot.upsert({
      where: { bakeryBranchId_serviceDate: { bakeryBranchId: fixture.branchId, serviceDate } },
      update: {},
      create: {
        tenantId: fixture.tenantId,
        bakeryBranchId: fixture.branchId,
        serviceDate,
        maxOrders: 1_000,
      },
    })
    // Real variant ids: the order item's foreign key is not decorative, and a
    // random one would only prove the fixture compiles.
    const offerings = await t.bakeryProductOffering.findMany({
      where: { id: { in: lines.map((line) => line.offeringId) } },
      select: { id: true, productVariantId: true },
    })
    const variantOf = new Map(offerings.map((offering) => [offering.id, offering.productVariantId]))

    const order = await t.order.create({
      data: {
        tenantId: fixture.tenantId,
        publicId: randomUUID().slice(0, 10).toUpperCase(),
        idempotencyKey: randomUUID(),
        customerId,
        cityId: fixture.cityId,
        operationalZoneId: fixture.zoneId,
        bakeryBranchId: fixture.branchId,
        bakeryCapacitySlotId: slot.id,
        state: (options.state ?? 'COMPLETED') as 'COMPLETED',
        // Not PAID: the database requires a paid order to have exactly one
        // captured payment behind it, and this suite is about what happens
        // after the bread arrives rather than about the money.
        paymentState: 'NOT_STARTED',
        recipientNameSnapshot: 'گیرنده',
        recipientPhoneSnapshot: '+989120000000',
        bakeryNameSnapshot: 'نانوایی',
        deliveryAddressSnapshot: 'نشانی',
        deliveryLatitudeSnapshot: '36.5442',
        deliveryLongitudeSnapshot: '52.6781',
        subtotalAmount: 100_000n,
        deliveryFeeAmount: 0n,
        discountAmount: 0n,
        totalAmount: 100_000n,
        currency: 'IRR',
        items: {
          create: lines.map((line) => ({
            tenantId: fixture.tenantId,
            bakeryProductOfferingId: line.offeringId,
            productVariantId: variantOf.get(line.offeringId)!,
            skuSnapshot: 'SKU',
            productNameFaSnapshot: line.nameFa,
            variantNameFaSnapshot: line.nameFa,
            fulfillmentClassSnapshot: 'SIGNATURE_FRESH',
            freshnessClaimSnapshot: 'FRESHLY_PRODUCED',
            quantity: line.quantity,
            // Half of what it costs today. A reorder that copies this is a bug
            // the assertions below will see.
            unitPriceAmount: 30_000n,
            lineTotalAmount: 30_000n * BigInt(line.quantity),
            currency: 'IRR',
          })),
        },
      },
    })
    if ((options.state ?? 'COMPLETED') === 'COMPLETED') {
      await t.orderStateTransition.create({
        data: {
          tenantId: fixture.tenantId,
          orderId: order.id,
          fromState: 'IN_FULFILLMENT',
          toState: 'COMPLETED',
          actorType: 'STAFF',
          idempotencyKey: `${order.id}:COMPLETED`,
          correlationId: randomUUID(),
          occurredAt: options.completedAt ?? new Date('2026-08-19T07:00:00.000Z'),
        },
      })
    }
    return order.id
  })
}

databaseDescribe('engagement against PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
    service = createPrismaEngagementService(prisma)
  })

  describe('ordering it again', () => {
    /**
     * The invariant that pays for the feature. A basket rebuilt at three-week
     * old prices sells bread below what it costs to bake.
     */
    it('rebuilds the basket at today prices, not the old ones', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 2, nameFa: 'سنگک' },
      ])
      const result = await service.reorder(
        fixture.tenantId,
        fixture.customerId,
        orderId,
        now,
        randomUUID(),
      )
      expect(result.addedCount).toBe(1)
      expect(result.adjustments).toEqual([])

      const cart = await withTenant(fixture.tenantId, (t) =>
        t.cart.findFirst({
          where: { id: result.cartId },
          include: { items: { include: { bakeryProductOffering: true } } },
        }),
      )
      expect(cart?.items).toHaveLength(1)
      expect(cart?.items[0]?.quantity).toBe(2)
      // 95,000 today, not the 30,000 the order was written at.
      expect(cart?.items[0]?.bakeryProductOffering.priceAmount).toBe(95_000n)
    })

    /**
     * A customer who taps "order again" and quietly receives one loaf instead
     * of two has been let down twice.
     */
    it('says what it could not repeat', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
        { offeringId: fixture.soldOutId, quantity: 3, nameFa: 'کماج' },
      ])
      const result = await service.reorder(
        fixture.tenantId,
        fixture.customerId,
        orderId,
        now,
        randomUUID(),
      )
      expect(result.addedCount).toBe(1)
      expect(result.adjustments).toEqual([
        {
          offeringId: fixture.soldOutId,
          nameFa: 'کماج',
          reason: 'REORDER_OFFERING_UNAVAILABLE',
          quantity: 3,
        },
      ])
    })

    /**
     * "Order again" means yesterday's order. Merging it into whatever was
     * already in the basket produces a basket the customer never chose.
     */
    it('replaces the basket rather than adding to it', async () => {
      const first = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 4, nameFa: 'سنگک' },
      ])
      const second = await completedOrder(fixture.customerId, [
        { offeringId: fixture.barbariId, quantity: 1, nameFa: 'بربری' },
      ])
      await service.reorder(fixture.tenantId, fixture.customerId, first, now, randomUUID())
      const result = await service.reorder(
        fixture.tenantId,
        fixture.customerId,
        second,
        now,
        randomUUID(),
      )
      const cart = await withTenant(fixture.tenantId, (t) =>
        t.cart.findFirst({ where: { id: result.cartId }, include: { items: true } }),
      )
      expect(cart?.items).toHaveLength(1)
      expect(cart?.items[0]?.bakeryProductOfferingId).toBe(fixture.barbariId)
    })

    it('refuses when nothing from the order is still sold', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.soldOutId, quantity: 1, nameFa: 'کماج' },
      ])
      await expect(
        service.reorder(fixture.tenantId, fixture.customerId, orderId, now, randomUUID()),
      ).rejects.toThrow(/REORDER_NOTHING_AVAILABLE/)
    })

    /** Another customer's order reads as absent, not as a refusal that confirms it. */
    it('will not reorder somebody else order', async () => {
      const orderId = await completedOrder(fixture.otherCustomerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      await expect(
        service.reorder(fixture.tenantId, fixture.customerId, orderId, now, randomUUID()),
      ).rejects.toThrow(/ORDER_NOT_FOUND/)
    })
  })

  describe('rating', () => {
    it('records a rating on a delivered order', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      const rating = await service.rateOrder(
        fixture.tenantId,
        fixture.customerId,
        orderId,
        { breadScore: 5, deliveryScore: 4, comment: '  گرم و تازه  ' },
        now,
        randomUUID(),
      )
      expect(rating.breadScore).toBe(5)
      expect(rating.deliveryScore).toBe(4)
      expect(rating.comment).toBe('گرم و تازه')

      expect(await service.findRating(fixture.tenantId, fixture.customerId, orderId)).toMatchObject(
        { breadScore: 5 },
      )
    })

    /** The rating is the customer's own statement about their own order. */
    it('writes a transactional engagement event', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      await service.rateOrder(
        fixture.tenantId,
        fixture.customerId,
        orderId,
        { breadScore: 4 },
        now,
        randomUUID(),
      )
      const event = await withTenant(fixture.tenantId, (t) =>
        t.customerEvent.findFirst({ where: { tenantId: fixture.tenantId, subjectId: orderId } }),
      )
      expect(event?.name).toBe('order.rated')
      expect(event?.consentBasis).toBe('TRANSACTIONAL')
    })

    it('refuses a second rating on the same order', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      const rate = () =>
        service.rateOrder(
          fixture.tenantId,
          fixture.customerId,
          orderId,
          { breadScore: 3 },
          now,
          randomUUID(),
        )
      await rate()
      await expect(rate()).rejects.toThrow(/RATING_ALREADY_SUBMITTED/)
    })

    it('refuses an order that has not arrived', async () => {
      const orderId = await completedOrder(
        fixture.customerId,
        [{ offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' }],
        { state: 'IN_FULFILLMENT' },
      )
      await expect(
        service.rateOrder(
          fixture.tenantId,
          fixture.customerId,
          orderId,
          { breadScore: 5 },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(/RATING_ORDER_NOT_DELIVERED/)
    })

    it('closes the window a month after delivery', async () => {
      const orderId = await completedOrder(
        fixture.customerId,
        [{ offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' }],
        { completedAt: new Date('2026-06-01T07:00:00.000Z') },
      )
      await expect(
        service.rateOrder(
          fixture.tenantId,
          fixture.customerId,
          orderId,
          { breadScore: 5 },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(/RATING_WINDOW_CLOSED/)
    })

    it('will not rate somebody else order', async () => {
      const orderId = await completedOrder(fixture.otherCustomerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      await expect(
        service.rateOrder(
          fixture.tenantId,
          fixture.customerId,
          orderId,
          { breadScore: 1 },
          now,
          randomUUID(),
        ),
      ).rejects.toThrow(EngagementError)
    })
  })

  describe('branch quality', () => {
    it('reports the average and refuses to flag on too few', async () => {
      const signal = await service.branchQuality(fixture.tenantId, fixture.branchId, now)
      expect(signal.sampleSize).toBeGreaterThan(0)
      expect(signal.averageHundredths).toBeGreaterThan(0)
      // Far fewer than ten ratings exist in this suite.
      expect(signal.flagForReview).toBe(false)
    })

    it('reports nothing for a branch nobody has rated', async () => {
      expect(await service.branchQuality(fixture.tenantId, randomUUID(), now)).toEqual({
        sampleSize: 0,
        averageHundredths: 0,
        flagForReview: false,
      })
    })

    /**
     * The report an operator opens every morning. Grouped in the database, so
     * it stays one query however many bakeries the platform grows to — and it
     * has to agree with the per-branch reading it summarises.
     */
    it('summarises every branch in one pass, agreeing with the single-branch read', async () => {
      const rows = await service.branchQualityReport(fixture.tenantId, now)
      const mine = rows.find((row) => row.bakeryBranchId === fixture.branchId)
      expect(mine).toBeDefined()
      expect(mine!.branchNameFa).toBe('شعبه')
      expect(mine!.signal).toEqual(
        await service.branchQuality(fixture.tenantId, fixture.branchId, now),
      )
    })

    /**
     * A left join, so a bakery nobody has rated still appears. An operator
     * needs to see the branch with no feedback at all just as much as the one
     * with bad feedback.
     */
    it('lists a branch nobody has rated rather than dropping it', async () => {
      const unrated = await withTenant(fixture.tenantId, async (t) => {
        const bakery = await t.bakery.findFirstOrThrow({ where: { tenantId: fixture.tenantId } })
        const zone = await t.operationalZone.findFirstOrThrow({
          where: { tenantId: fixture.tenantId },
        })
        return t.bakeryBranch.create({
          data: {
            tenantId: fixture.tenantId,
            bakeryId: bakery.id,
            cityId: fixture.cityId,
            operationalZoneId: zone.id,
            code: `QQ${suffix}`.slice(0, 16),
            nameFa: 'شعبهٔ بی‌نظر',
            addressLine: 'نشانی',
            latitude: '36.5513',
            longitude: '52.6790',
            operationalStatus: 'ACTIVE',
            qualityStatus: 'APPROVED',
          },
        })
      })
      const rows = await service.branchQualityReport(fixture.tenantId, now)
      const row = rows.find((entry) => entry.bakeryBranchId === unrated.id)
      expect(row?.signal).toEqual({ sampleSize: 0, averageHundredths: 0, flagForReview: false })
    })
  })

  describe('favourites', () => {
    it('keeps one, lists it, and drops it', async () => {
      await service.addFavourite(fixture.tenantId, fixture.customerId, fixture.sangakId)
      const listed = await service.listFavourites(fixture.tenantId, fixture.customerId)
      expect(listed.map((entry) => entry.offeringId)).toContain(fixture.sangakId)
      expect(listed[0]?.nameFa).toBe('سنگک')
      expect(listed[0]?.priceAmount).toBe('95000')

      await service.removeFavourite(fixture.tenantId, fixture.customerId, fixture.sangakId)
      expect(await service.listFavourites(fixture.tenantId, fixture.customerId)).toEqual([])
    })

    it('treats a second tap as the same favourite', async () => {
      await service.addFavourite(fixture.tenantId, fixture.customerId, fixture.barbariId)
      await service.addFavourite(fixture.tenantId, fixture.customerId, fixture.barbariId)
      expect(await service.listFavourites(fixture.tenantId, fixture.customerId)).toHaveLength(1)
      await service.removeFavourite(fixture.tenantId, fixture.customerId, fixture.barbariId)
    })

    /**
     * A favourite that has sold out is still the customer's favourite. Removing
     * it from the list would look like the platform lost it.
     */
    it('keeps a sold-out favourite in the list and says it is gone', async () => {
      await service.addFavourite(fixture.tenantId, fixture.customerId, fixture.soldOutId)
      const listed = await service.listFavourites(fixture.tenantId, fixture.customerId)
      expect(listed[0]?.offeringId).toBe(fixture.soldOutId)
      expect(listed[0]?.available).toBe(false)
      await service.removeFavourite(fixture.tenantId, fixture.customerId, fixture.soldOutId)
    })

    it('refuses a favourite for a loaf that does not exist', async () => {
      await expect(
        service.addFavourite(fixture.tenantId, fixture.customerId, randomUUID()),
      ).rejects.toThrow(/OFFERING_NOT_FOUND/)
    })

    it('removing one that was never there is not a failure', async () => {
      await expect(
        service.removeFavourite(fixture.tenantId, fixture.customerId, randomUUID()),
      ).resolves.toBeUndefined()
    })
  })

  describe('the guards the database keeps of its own', () => {
    /**
     * Row-level security separates tenants, not customers. Without the trigger
     * a rating could be written against somebody else's order inside the same
     * tenant and nothing in the database would say it was wrong.
     */
    it('refuses a rating written against another customer order', async () => {
      const orderId = await completedOrder(fixture.otherCustomerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.orderRating.create({
            data: {
              tenantId: fixture.tenantId,
              orderId,
              customerId: fixture.customerId,
              breadScore: 1,
            },
          }),
        ),
      ).rejects.toThrow(/customer whose order it is/)
    })

    it('refuses a score outside one to five', async () => {
      const orderId = await completedOrder(fixture.customerId, [
        { offeringId: fixture.sangakId, quantity: 1, nameFa: 'سنگک' },
      ])
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.orderRating.create({
            data: {
              tenantId: fixture.tenantId,
              orderId,
              customerId: fixture.customerId,
              breadScore: 9,
            },
          }),
        ),
      ).rejects.toThrow(/order_rating_score_check/)
    })
  })
})
