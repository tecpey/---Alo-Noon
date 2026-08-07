import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaAdminReportingService } from './modules/admin-reporting'

/**
 * Exercises the reporting aggregates against PostgreSQL with orders whose totals
 * are known, so the arithmetic is checked rather than assumed. The figures are
 * bigint Rial deliberately larger than Number.MAX_SAFE_INTEGER in aggregate: a
 * report that silently rounds revenue is the kind of bug that survives review.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service = createPrismaAdminReportingService(prisma, { reportingTimeZone: 'UTC' })

const suffix = randomUUID().slice(0, 8).toUpperCase()
const from = new Date('2026-03-01T00:00:00.000Z')
const to = new Date('2026-03-08T00:00:00.000Z')

interface Seeded {
  tenantId: string
  otherTenantId: string
  customerId: string
  orderIds: string[]
}

let seeded: Seeded

afterAll(async () => prisma.$disconnect())

databaseDescribe('admin reporting over PostgreSQL', () => {
  beforeAll(async () => {
    seeded = await seedTenantWithOrders()
  }, 60_000)

  it('reports placed value without counting drafts or losing precision', async () => {
    const report = await service.salesReport(seeded.tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })

    // Seeded: three CONFIRMED at 9,007,199,254,740,993 / …992 / …999 Rial, one
    // CANCELLED at 5,000,000, and one DRAFT at 999,999,999 that must not appear.
    // A cancelled order was still placed, so it belongs in the placed figures
    // and is reported separately for whoever wants to net it out.
    expect(report.totals.placedOrders).toBe(4)
    expect(report.totals.placedValue.amount).toBe('27021597769222984')
    // Beyond the float-safe range, so a Number round-trip would have shifted it.
    expect(Number(report.totals.placedValue.amount)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)

    expect(report.totals.cancelledOrders).toBe(1)
    expect(report.totals.cancelledValue.amount).toBe('5000000')
    // Nothing is captured yet, so PAID is empty by design, not by accident.
    expect(report.totals.paidOrders).toBe(0)
    expect(report.totals.paidValue.amount).toBe('0')

    // Integer division: 27021597769222984 / 4.
    expect(report.totals.averageOrderValue.amount).toBe('6755399442305746')
  })

  it('buckets orders by state and payment state', async () => {
    const report = await service.salesReport(seeded.tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })
    expect(report.ordersByState['CONFIRMED']).toBe(3)
    expect(report.ordersByState['CANCELLED']).toBe(1)
    expect(report.ordersByState['DRAFT']).toBeUndefined()
    expect(report.ordersByPaymentState['NOT_STARTED']).toBe(4)
  })

  it('groups by calendar day in the reporting timezone', async () => {
    const report = await service.salesReport(seeded.tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })
    const days = report.daily.map((point) => point.date)
    expect(days).toEqual([...days].sort())
    expect(days).toContain('2026-03-02')
    const second = report.daily.find((point) => point.date === '2026-03-02')
    expect(second?.placedOrders).toBeGreaterThan(0)
  })

  it('ranks products by the names they actually sold under', async () => {
    const report = await service.salesReport(seeded.tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })
    const top = report.topProducts[0]
    expect(top).toBeDefined()
    expect(top?.sku).toBe(`REPORT-SKU-${suffix}`)
    // Snapshot name, not the live catalog row, which was renamed after the sale.
    expect(top?.productNameFa).toBe('نان سنگک')
    expect(top?.quantity).toBe(8)
  })

  it('excludes another tenant’s orders entirely', async () => {
    const report = await service.salesReport(seeded.otherTenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })
    expect(report.totals.placedOrders).toBe(0)
    expect(report.totals.placedValue.amount).toBe('0')
    expect(report.topProducts).toEqual([])
  })

  it('rejects an inverted or absurdly wide range', async () => {
    await expect(
      service.salesReport(seeded.tenantId, { from: to.toISOString(), to: from.toISOString() }),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_INVALID' })
    await expect(
      service.salesReport(seeded.tenantId, {
        from: '2020-01-01T00:00:00.000Z',
        to: '2030-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' })
  })

  it('lists orders newest first, paginated, without drafts', async () => {
    const first = await service.listOrders(seeded.tenantId, { page: 1, pageSize: 2 })
    expect(first.totalItems).toBe(4)
    expect(first.orders).toHaveLength(2)
    const timestamps = first.orders.map((order) => order.createdAt)
    expect(timestamps).toEqual([...timestamps].sort().reverse())

    const second = await service.listOrders(seeded.tenantId, { page: 2, pageSize: 2 })
    expect(second.orders).toHaveLength(2)
    const ids = new Set([...first.orders, ...second.orders].map((order) => order.id))
    expect(ids.size).toBe(4)
  })

  it('filters by state and by exact public id', async () => {
    const cancelled = await service.listOrders(seeded.tenantId, {
      page: 1,
      pageSize: 20,
      state: 'CANCELLED',
    })
    expect(cancelled.totalItems).toBe(1)

    const listed = await service.listOrders(seeded.tenantId, { page: 1, pageSize: 1 })
    const publicId = listed.orders[0]?.publicId
    expect(publicId).toBeDefined()
    const found = await service.listOrders(seeded.tenantId, {
      page: 1,
      pageSize: 20,
      search: publicId!,
    })
    expect(found.totalItems).toBe(1)

    // A prefix must not match, so an operator cannot enumerate by partial id.
    const partial = await service.listOrders(seeded.tenantId, {
      page: 1,
      pageSize: 20,
      search: publicId!.slice(0, 6),
    })
    expect(partial.totalItems).toBe(0)
  })

  it('returns order detail with items and transitions, and nothing for another tenant', async () => {
    const orderId = seeded.orderIds[0]!
    const detail = await service.findOrder(seeded.tenantId, orderId)
    expect(detail?.id).toBe(orderId)
    expect(detail?.items.length).toBeGreaterThan(0)
    expect(detail?.recipientPhoneSnapshot).toMatch(/^\+989/)
    expect(detail?.items[0]?.lineTotal.currency).toBe('IRR')

    expect(await service.findOrder(seeded.otherTenantId, orderId)).toBeNull()
  })

  it('reports the cart-to-order funnel', async () => {
    const report = await service.salesReport(seeded.tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
    })
    expect(report.conversion.orders).toBe(4)
    expect(report.conversion.quoteToOrderRate).toBeNull()
  })
})

async function seedTenantWithOrders(): Promise<Seeded> {
  const tenant = await prisma.tenant.create({
    data: { slug: `reporting-${suffix.toLowerCase()}`, name: `Reporting ${suffix}` },
  })
  const otherTenant = await prisma.tenant.create({
    data: { slug: `reporting-other-${suffix.toLowerCase()}`, name: `Reporting other ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `RPT-${suffix}`, nameFa: 'شهر گزارش', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `RPTZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Reporting Bakery ${suffix}`,
      displayNameFa: 'نانوایی گزارش',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `RPTB-${suffix}`,
      nameFa: 'شعبه گزارش',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const category = await prisma.productCategory.create({
    data: { tenantId, code: `RPTC-${suffix}`, nameFa: 'دسته' },
  })
  const product = await prisma.product.create({
    data: {
      tenantId,
      categoryId: category.id,
      slug: `reporting-product-${suffix.toLowerCase()}`,
      // Renamed after the sale, to prove the report uses the line-item snapshot.
      nameFa: 'نام جدید پس از فروش',
      lifecycle: 'ACTIVE',
    },
  })
  const variant = await prisma.productVariant.create({
    data: {
      tenantId,
      productId: product.id,
      sku: `REPORT-SKU-${suffix}`,
      nameFa: 'گونه',
      fulfillmentClass: 'SIGNATURE_FRESH',
      freshnessClaim: 'FRESHLY_PRODUCED',
      productionMode: 'MADE_TO_ORDER',
      fulfillmentControl: 'CONTROLLED_PICKUP',
      productionWindowMinutes: 30,
      pickupWithinMinutes: 15,
      freshnessWindowMinutes: 60,
      ingredients: [],
      allergens: [],
      dietaryAttributes: [],
      lifecycle: 'ACTIVE',
    },
  })
  const offering = await prisma.bakeryProductOffering.create({
    data: {
      tenantId,
      bakeryBranchId: branch.id,
      productVariantId: variant.id,
      priceAmount: 250_000n,
      availability: 'AVAILABLE',
      dailyCapacity: 20,
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: `+9891${suffix.slice(0, 8).replace(/\D/g, '1').padEnd(8, '2')}` },
  })

  // Totals chosen to exceed the float-safe range once summed.
  const placed: Array<{ total: bigint; day: string; state: 'CONFIRMED' | 'CANCELLED' }> = [
    { total: 9_007_199_254_740_993n, day: '2026-03-01T09:00:00.000Z', state: 'CONFIRMED' },
    { total: 9_007_199_254_740_992n, day: '2026-03-02T09:00:00.000Z', state: 'CONFIRMED' },
    { total: 9_007_199_254_740_999n, day: '2026-03-03T09:00:00.000Z', state: 'CONFIRMED' },
    { total: 5_000_000n, day: '2026-03-04T09:00:00.000Z', state: 'CANCELLED' },
  ]

  const orderIds: string[] = []
  for (const [index, entry] of placed.entries()) {
    const order = await createOrder({
      tenantId,
      customerId: customer.id,
      cityId: city.id,
      zoneId: zone.id,
      branchId: branch.id,
      variantId: variant.id,
      offeringId: offering.id,
      total: entry.total,
      createdAt: new Date(entry.day),
      state: entry.state,
      quantity: 2,
      index,
    })
    orderIds.push(order)
  }

  // A draft that every figure must ignore.
  await createOrder({
    tenantId,
    customerId: customer.id,
    cityId: city.id,
    zoneId: zone.id,
    branchId: branch.id,
    variantId: variant.id,
    offeringId: offering.id,
    total: 999_999_999n,
    createdAt: new Date('2026-03-05T09:00:00.000Z'),
    state: 'DRAFT',
    quantity: 100,
    index: 99,
  })

  return { tenantId, otherTenantId: otherTenant.id, customerId: customer.id, orderIds }
}

async function createOrder(input: {
  tenantId: string
  customerId: string
  cityId: string
  zoneId: string
  branchId: string
  variantId: string
  offeringId: string
  total: bigint
  createdAt: Date
  state: 'CONFIRMED' | 'CANCELLED' | 'DRAFT'
  quantity: number
  index: number
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      tenantId: input.tenantId,
      idempotencyKey: `reporting-${suffix}-${input.index}`,
      customerId: input.customerId,
      cityId: input.cityId,
      operationalZoneId: input.zoneId,
      bakeryBranchId: input.branchId,
      state: input.state,
      recipientNameSnapshot: 'گیرنده تست',
      recipientPhoneSnapshot: '+989121234567',
      deliveryAddressSnapshot: 'نشانی تحویل',
      deliveryLatitudeSnapshot: '36.5442',
      deliveryLongitudeSnapshot: '52.6781',
      bakeryNameSnapshot: 'نانوایی گزارش',
      subtotalAmount: input.total,
      deliveryFeeAmount: 0n,
      discountAmount: 0n,
      totalAmount: input.total,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      items: {
        create: [
          {
            tenantId: input.tenantId,
            productVariantId: input.variantId,
            bakeryProductOfferingId: input.offeringId,
            skuSnapshot: `REPORT-SKU-${suffix}`,
            productNameFaSnapshot: 'نان سنگک',
            variantNameFaSnapshot: 'گونه',
            fulfillmentClassSnapshot: 'SIGNATURE_FRESH',
            freshnessClaimSnapshot: 'FRESHLY_PRODUCED',
            quantity: input.quantity,
            unitPriceAmount: 250_000n,
            lineTotalAmount: BigInt(input.quantity) * 250_000n,
          },
        ],
      },
    },
  })
  return order.id
}
