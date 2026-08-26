import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { URBAN_DETOUR_FACTOR } from '@alo-noon/domain'

import { createPrismaAdminLogisticsService } from './modules/admin-logistics'

/**
 * The logistics report over a real database.
 *
 * The arithmetic is covered in the domain; what is only observable here is
 * whether the SQL counts the right rows — which is where a report goes wrong in
 * the way nobody notices, because a plausible number looks exactly like a
 * correct one.
 *
 * So the scenarios are built to separate things a careless query would merge: a
 * cancelled delivery from a failed one, a fee on an undelivered order from a fee
 * on a delivered one, and one tenant's couriers from another's.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const HOME = { latitude: 36.5501, longitude: 52.6899 }
const RANGE = {
  from: new Date('2026-08-01T00:00:00.000Z').toISOString(),
  to: new Date('2026-09-01T00:00:00.000Z').toISOString(),
}
const PLACED_AT = new Date('2026-08-15T09:00:00.000Z')

afterAll(async () => prisma.$disconnect())

databaseDescribe('the logistics report over PostgreSQL', () => {
  it('separates a failed delivery from a cancelled one', async () => {
    const world = await buildWorld('OUTCOMES')
    await world.delivery({ taskState: 'DELIVERED' })
    await world.delivery({ taskState: 'DELIVERED' })
    await world.delivery({ taskState: 'FAILED', failureReasonCode: 'RECIPIENT_ABSENT' })
    await world.delivery({ taskState: 'CANCELLED' })
    await world.delivery({ taskState: 'OUT_FOR_DELIVERY' })

    const report = await world.report()

    expect(report.outcomes).toEqual({
      delivered: 2,
      failed: 1,
      cancelled: 1,
      inFlight: 1,
      // One failure in three settled deliveries. The cancellation and the
      // in-flight run are in neither half: a customer cancelling is not a
      // courier failing, and work with no verdict has no verdict to count.
      failureRate: 0.3333,
    })
    expect(report.failureReasons).toEqual([{ reasonCode: 'RECIPIENT_ABSENT', deliveries: 1 }])
  })

  it('counts fees and distance only for deliveries that actually arrived', async () => {
    const world = await buildWorld('ECONOMICS')
    await world.delivery({ taskState: 'DELIVERED', feeAmount: 60_000n, distanceMetres: 2_000 })
    await world.delivery({ taskState: 'DELIVERED', feeAmount: 40_000n, distanceMetres: 2_000 })
    // A fee charged on an order the courier never delivered is money that will
    // be refunded; counting it would flatter both revenue and distance.
    await world.delivery({ taskState: 'FAILED', feeAmount: 900_000n, distanceMetres: 90_000 })

    const report = await world.report()

    expect(report.economics).toEqual({
      deliveries: 2,
      feesCharged: { amount: '100000', currency: 'IRR' },
      distanceMetres: 4_000,
      feePerDelivery: { amount: '50000', currency: 'IRR' },
      feePerKilometre: { amount: '25000', currency: 'IRR' },
      metresPerDelivery: 2_000,
    })
  })

  it('reports the batch density that batching has to beat', async () => {
    const world = await buildWorld('BATCH')
    await world.delivery({ taskState: 'DELIVERED' })
    await world.delivery({ taskState: 'DELIVERED' })

    const report = await world.report()

    // Two runs by the same courier on the same day is one run, so this is the
    // number that rises when batching lands rather than one that already did.
    expect(report.batching).toEqual({ runs: 1, deliveries: 2, density: 2 })
  })

  it('counts a second courier as a second run', async () => {
    const world = await buildWorld('TWORIDERS')
    await world.delivery({ taskState: 'DELIVERED' })
    await world.delivery({ taskState: 'DELIVERED', secondCourier: true })

    expect((await world.report()).batching).toEqual({ runs: 2, deliveries: 2, density: 1 })
  })

  it('shows how many fares were measured and why the rest were not', async () => {
    const world = await buildWorld('COVERAGE')
    await world.delivery({ taskState: 'DELIVERED', distanceSource: 'ROUTED' })
    await world.delivery({ taskState: 'DELIVERED', distanceSource: 'ROUTED' })
    await world.delivery({
      taskState: 'DELIVERED',
      distanceSource: 'ESTIMATED',
      distanceReasonCode: 'NESHAN_HTTP_429',
    })
    // A quote from before routing existed. Not an outage, and folding it in
    // would make a historical range look like one.
    await world.delivery({ taskState: 'DELIVERED', distanceSource: null })

    const report = await world.report()

    expect(report.routing.routed).toBe(2)
    expect(report.routing.estimated).toBe(1)
    expect(report.routing.unattributed).toBe(1)
    expect(report.routing.routedShare).toBe(0.6667)
    expect(report.routing.fallbackReasons).toEqual([{ reasonCode: 'NESHAN_HTTP_429', quotes: 1 }])
  })

  it('measures the detour factor the assumed one exists to be replaced by', async () => {
    const world = await buildWorld('DETOUR')
    // The straight line between BRANCH and HOME is about 1,242 metres, so a
    // routed 2,484 is very close to twice around.
    await world.delivery({
      taskState: 'DELIVERED',
      distanceSource: 'ROUTED',
      distanceMetres: 2_484,
    })

    const report = await world.report()

    expect(report.detour.samples).toBe(1)
    expect(report.detour.assumedFactor).toBe(URBAN_DETOUR_FACTOR)
    expect(report.detour.measuredFactor).toBeGreaterThan(1.9)
    expect(report.detour.measuredFactor).toBeLessThan(2.1)
    // The point of the pairing: an operator seeing 2.0 against an assumed 1.3
    // knows their fallback is undercharging by a third on every estimated fare.
    expect(report.detour.measuredFactor).toBeGreaterThan(report.detour.assumedFactor)
  })

  it('says nothing rather than zero when a period has no deliveries', async () => {
    const world = await buildWorld('EMPTY')

    const report = await world.report()

    // Zero would read as "no failures" and "no detour"; null reads as "nothing
    // to say yet", which is what is actually true of a quiet week.
    expect(report.outcomes.failureRate).toBeNull()
    expect(report.batching.density).toBeNull()
    expect(report.routing.routedShare).toBeNull()
    expect(report.detour.measuredFactor).toBeNull()
    expect(report.economics.feePerDelivery).toBeNull()
  })

  it('never counts another tenant’s deliveries', async () => {
    const first = await buildWorld('TENANTA')
    const second = await buildWorld('TENANTB')
    await first.delivery({ taskState: 'DELIVERED' })
    await second.delivery({ taskState: 'DELIVERED' })
    await second.delivery({ taskState: 'FAILED', failureReasonCode: 'RECIPIENT_ABSENT' })

    const report = await first.report()

    expect(report.outcomes.delivered).toBe(1)
    expect(report.outcomes.failed).toBe(0)
    expect(report.failureReasons).toEqual([])
  })

  it('leaves an order outside the range out of every figure', async () => {
    const world = await buildWorld('RANGE')
    await world.delivery({ taskState: 'DELIVERED' })
    await world.delivery({
      taskState: 'FAILED',
      failureReasonCode: 'RECIPIENT_ABSENT',
      placedAt: new Date('2026-07-01T09:00:00.000Z'),
    })

    const report = await world.report()

    expect(report.outcomes.delivered).toBe(1)
    expect(report.outcomes.failed).toBe(0)
  })

  it('refuses a range that is inverted or absurdly wide', async () => {
    const world = await buildWorld('BOUNDS')

    await expect(
      world.service.logisticsReport(world.tenantId, { from: RANGE.to, to: RANGE.from }),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_INVALID' })
    await expect(
      world.service.logisticsReport(world.tenantId, {
        from: new Date('2000-01-01T00:00:00.000Z').toISOString(),
        to: RANGE.to,
      }),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' })
  })
})

interface DeliveryOptions {
  taskState: 'DELIVERED' | 'FAILED' | 'CANCELLED' | 'OUT_FOR_DELIVERY'
  failureReasonCode?: string
  feeAmount?: bigint
  distanceMetres?: number
  distanceSource?: 'ROUTED' | 'ESTIMATED' | null
  distanceReasonCode?: string
  secondCourier?: boolean
  placedAt?: Date
}

async function buildWorld(label: string) {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const now = new Date()
  const service = createPrismaAdminLogisticsService(prisma)

  const tenant = await prisma.tenant.create({
    data: { slug: `lg-${suffix.toLowerCase()}`, name: `Logistics ${suffix}` },
  })
  const tenantId = tenant.id
  const city = await prisma.city.create({
    data: { tenantId, code: `LC${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `LZ${suffix}`.slice(0, 16),
      nameFa: 'ناحیه',
      isActive: true,
    },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Bakery ${suffix}`,
      displayNameFa: 'نانوایی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `LB${suffix}`.slice(0, 16),
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: String(BRANCH.latitude),
      longitude: String(BRANCH.longitude),
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+9893${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
    },
  })
  const partner = await prisma.courierPartner.create({
    data: { tenantId, code: `LP${suffix}`.slice(0, 16), displayName: 'پیک', isActive: true },
  })
  const couriers = await Promise.all(
    ['A', 'B'].map((letter) =>
      prisma.courier.create({
        data: {
          tenantId,
          courierPartnerId: partner.id,
          displayName: `پیک ${letter}`,
          status: 'AVAILABLE',
          mobileE164: `+9894${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
        },
      }),
    ),
  )

  return {
    tenantId,
    service,

    /**
     * One order that reached a courier, written directly.
     *
     * Driving these through the real services would need a signed-in customer,
     * a payment, an operator acceptance and a courier per case — and would test
     * those services rather than this query. What matters here is which rows the
     * report counts, so the rows are placed exactly.
     */
    async delivery(options: DeliveryOptions) {
      const key = randomUUID()
      // The database checks that the total is the sum of its parts, which is
      // the invariant the report's revenue figures rest on.
      const feeAmount = options.feeAmount ?? 50_000n
      const subtotal = 500_000n
      const total = subtotal + feeAmount
      const cart = await prisma.cart.create({
        data: {
          tenantId,
          customerId: customer.id,
          cityId: city.id,
          operationalZoneId: zone.id,
          bakeryBranchId: branch.id,
          state: 'CONVERTED',
        },
      })
      const quote = await prisma.quote.create({
        data: {
          tenantId,
          idempotencyKey: `lg-quote-${key}`,
          customerId: customer.id,
          cartId: cart.id,
          cartVersion: 1,
          status: 'ACCEPTED',
          expiresAt: new Date(now.getTime() + 3_600_000),
          subtotalAmount: subtotal,
          deliveryFeeAmount: feeAmount,
          totalAmount: total,
          deliveryDistanceMeters: options.distanceMetres ?? 1_500,
          ...(options.distanceSource !== null && {
            deliveryDistanceSource: options.distanceSource ?? 'ROUTED',
            ...(options.distanceReasonCode && {
              deliveryDistanceReasonCode: options.distanceReasonCode,
            }),
          }),
          deliveryLatitudeSnapshot: String(HOME.latitude),
          deliveryLongitudeSnapshot: String(HOME.longitude),
        },
      })
      const order = await prisma.order.create({
        data: {
          tenantId,
          idempotencyKey: `lg-order-${key}`,
          customerId: customer.id,
          cityId: city.id,
          operationalZoneId: zone.id,
          bakeryBranchId: branch.id,
          quoteId: quote.id,
          state: 'COMPLETED',
          recipientNameSnapshot: 'گیرنده',
          recipientPhoneSnapshot: '+989121234567',
          deliveryAddressSnapshot: 'نشانی تحویل',
          deliveryLatitudeSnapshot: String(HOME.latitude),
          deliveryLongitudeSnapshot: String(HOME.longitude),
          bakeryNameSnapshot: 'نانوایی',
          subtotalAmount: subtotal,
          deliveryFeeAmount: feeAmount,
          totalAmount: total,
          createdAt: options.placedAt ?? PLACED_AT,
        },
      })
      const fulfillment = await prisma.fulfillment.create({
        data: {
          tenantId,
          orderId: order.id,
          bakeryBranchId: branch.id,
          type: 'BAKERY_PICKUP_DELIVERY',
          state: 'COMPLETED',
        },
      })
      const task = await prisma.deliveryTask.create({
        data: {
          tenantId,
          fulfillmentId: fulfillment.id,
          state: options.taskState,
          ...(options.failureReasonCode && { failureReasonCode: options.failureReasonCode }),
        },
      })
      await prisma.deliveryAssignment.create({
        data: {
          tenantId,
          deliveryTaskId: task.id,
          courierId: couriers[options.secondCourier ? 1 : 0]!.id,
          state: options.taskState === 'DELIVERED' ? 'COMPLETED' : 'CANCELLED',
          offeredAt: options.placedAt ?? PLACED_AT,
          endedAt: options.placedAt ?? PLACED_AT,
        },
      })
    },

    report() {
      return service.logisticsReport(tenantId, RANGE)
    },
  }
}
