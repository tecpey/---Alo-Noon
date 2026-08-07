import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaAddressRepository } from './modules/addresses'
import { createPrismaCommerceRepository } from './modules/commerce'
import { createPrismaOrderRepository } from './modules/orders'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantId = '00000000-0000-4000-8000-000000000001'
const tracked = {
  customers: [] as string[],
  cityId: '',
  zoneId: '',
  serviceAreaId: '',
  pricingRuleId: '',
  bakeryId: '',
  branchId: '',
  categoryId: '',
  productId: '',
  variantId: '',
  offeringId: '',
  capacitySlotId: '',
}

afterEach(async () => {
  if (!tracked.cityId) return
  await prisma.orderStateTransition.deleteMany({
    where: { order: { customerId: { in: tracked.customers } } },
  })
  await prisma.orderItem.deleteMany({ where: { order: { customerId: { in: tracked.customers } } } })
  await prisma.domainEventOutbox.deleteMany({ where: { actorId: { in: tracked.customers } } })
  await prisma.auditEvent.deleteMany({ where: { actorId: { in: tracked.customers } } })
  await prisma.order.deleteMany({ where: { customerId: { in: tracked.customers } } })
  await prisma.quote.deleteMany({ where: { customerId: { in: tracked.customers } } })
  await prisma.cart.deleteMany({ where: { customerId: { in: tracked.customers } } })
  await prisma.address.deleteMany({ where: { customerId: { in: tracked.customers } } })
  await prisma.customer.deleteMany({ where: { id: { in: tracked.customers } } })
  await prisma.bakeryCapacitySlot.deleteMany({ where: { id: tracked.capacitySlotId } })
  await prisma.bakeryProductOffering.deleteMany({ where: { id: tracked.offeringId } })
  await prisma.productVariant.deleteMany({ where: { id: tracked.variantId } })
  await prisma.product.deleteMany({ where: { id: tracked.productId } })
  await prisma.productCategory.deleteMany({ where: { id: tracked.categoryId } })
  await prisma.deliveryPricingRule.deleteMany({ where: { id: tracked.pricingRuleId } })
  await prisma.bakeryBranch.deleteMany({ where: { id: tracked.branchId } })
  await prisma.bakery.deleteMany({ where: { id: tracked.bakeryId } })
  await prisma.serviceArea.deleteMany({ where: { id: tracked.serviceAreaId } })
  await prisma.operationalZone.deleteMany({ where: { id: tracked.zoneId } })
  await prisma.city.deleteMany({ where: { id: tracked.cityId } })
  tracked.customers = []
  for (const key of [
    'cityId',
    'zoneId',
    'serviceAreaId',
    'pricingRuleId',
    'bakeryId',
    'branchId',
    'categoryId',
    'productId',
    'variantId',
    'offeringId',
    'capacitySlotId',
  ] as const)
    tracked[key] = ''
})

afterAll(async () => prisma.$disconnect())

databaseDescribe('ready-stock inventory at order acceptance', () => {
  async function seedStockTrackedOffering(stockOnHand: number, maxOrders: number) {
    const suffix = randomUUID().slice(0, 8)
    const now = new Date('2026-08-07T10:00:00.000Z')
    const city = await prisma.city.create({
      data: {
        tenantId,
        code: `INV-${suffix}`,
        nameFa: 'شهر تست',
        timezone: 'Asia/Tehran',
        isActive: true,
      },
    })
    tracked.cityId = city.id
    const zone = await prisma.operationalZone.create({
      data: {
        tenantId,
        cityId: city.id,
        code: `ZONE-${suffix}`,
        nameFa: 'محدوده تست',
        isActive: true,
      },
    })
    tracked.zoneId = zone.id
    const serviceArea = await prisma.serviceArea.create({
      data: {
        tenantId,
        operationalZoneId: zone.id,
        code: `AREA-${suffix}`,
        nameFa: 'ناحیه تست',
        isActive: true,
        boundaryGeoJson: {
          type: 'Polygon',
          coordinates: [
            [
              [52.6, 36.4],
              [52.8, 36.4],
              [52.8, 36.7],
              [52.6, 36.7],
              [52.6, 36.4],
            ],
          ],
        },
      },
    })
    tracked.serviceAreaId = serviceArea.id
    const bakery = await prisma.bakery.create({
      data: {
        tenantId,
        legalName: `Inventory Bakery ${suffix}`,
        displayNameFa: 'نانوایی تست',
        partnerStatus: 'ACTIVE',
      },
    })
    tracked.bakeryId = bakery.id
    const branch = await prisma.bakeryBranch.create({
      data: {
        tenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `BRANCH-${suffix}`,
        nameFa: 'شعبه تست',
        addressLine: 'نشانی شعبه تست',
        latitude: '36.5442',
        longitude: '52.6781',
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    tracked.branchId = branch.id
    const category = await prisma.productCategory.create({
      data: { tenantId, code: `INV-CAT-${suffix}`, nameFa: 'دسته تست' },
    })
    tracked.categoryId = category.id
    const product = await prisma.product.create({
      data: {
        tenantId,
        categoryId: category.id,
        slug: `inventory-product-${suffix}`,
        nameFa: 'نان بسته‌بندی تست',
        lifecycle: 'ACTIVE',
      },
    })
    tracked.productId = product.id
    const variant = await prisma.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        sku: `INV-SKU-${suffix}`,
        nameFa: 'نان بسته‌بندی',
        fulfillmentClass: 'PACKAGED_TRADITIONAL',
        freshnessClaim: 'PACKAGED',
        productionMode: 'READY_STOCK',
        fulfillmentControl: 'PLATFORM_STOCK',
        packagingType: 'ALO_NOON_SEALED',
        shelfLifeMinutes: 1_440,
        ingredients: [],
        allergens: [],
        dietaryAttributes: [],
        lifecycle: 'ACTIVE',
      },
    })
    tracked.variantId = variant.id
    const offering = await prisma.bakeryProductOffering.create({
      data: {
        tenantId,
        bakeryBranchId: branch.id,
        productVariantId: variant.id,
        priceAmount: 120_000n,
        availability: 'AVAILABLE',
        stockTracked: true,
        stockOnHand: stockOnHand,
      },
    })
    tracked.offeringId = offering.id
    const pricingRule = await prisma.deliveryPricingRule.create({
      data: {
        tenantId,
        cityId: city.id,
        operationalZoneId: zone.id,
        version: 1,
        calculationMode: 'DISTANCE_BANDED',
        baseFeeAmount: 20_000n,
        perKilometerFeeAmount: 10_000n,
        minimumOrderAmount: 100_000n,
        freeDeliveryThreshold: 2_000_000n,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        isActive: true,
      },
    })
    tracked.pricingRuleId = pricingRule.id
    const capacity = await prisma.bakeryCapacitySlot.create({
      data: {
        tenantId,
        bakeryBranchId: branch.id,
        serviceDate: new Date('2026-08-07T00:00:00.000Z'),
        maxOrders,
        reservedOrders: 0,
      },
    })
    tracked.capacitySlotId = capacity.id

    const commerce = createPrismaCommerceRepository(prisma)
    const addressRepository = createPrismaAddressRepository(prisma)
    const orders = createPrismaOrderRepository(prisma)

    // Quote creation happens sequentially per customer (each has its own cart, but
    // both race the same offering/capacity rows); only order acceptance below is
    // the concurrency boundary this test actually exercises, matching the pattern
    // in checkout.integration.test.ts's capacity-arbitration test.
    const createCustomerQuote = async (sequence: number) => {
      const customer = await prisma.customer.create({
        data: {
          tenantId,
          mobileE164: `+9892${String(sequence).padStart(8, '0')}`,
          lifecycleStatus: 'ACTIVE',
        },
      })
      tracked.customers.push(customer.id)
      const address = await addressRepository.create(
        tenantId,
        customer.id,
        {
          cityId: city.id,
          idempotencyKey: `address-${suffix}-${sequence}`,
          label: 'خانه',
          recipientName: `مشتری ${sequence}`,
          recipientPhone: '+989111111111',
          addressLine: `نشانی immutable شماره ${sequence} برای تحویل`,
          latitude: 36.5387,
          longitude: 52.6765,
        },
        now,
        randomUUID(),
      )
      const cart = await commerce.upsertItem(
        tenantId,
        customer.id,
        offering.id,
        { cityId: city.id, operationalZoneId: zone.id, quantity: 1 },
        now,
        randomUUID(),
      )
      const quote = await commerce.createQuote(
        tenantId,
        customer.id,
        {
          deliveryAddressId: address.id,
          expectedCartVersion: cart.version,
          idempotencyKey: `quote-${suffix}-${sequence}`,
        },
        now,
        randomUUID(),
      )
      return { customer, quote }
    }

    const acceptQuote = (customerId: string, quoteId: string, sequence: number) =>
      orders.create(
        tenantId,
        customerId,
        { quoteId, idempotencyKey: `order-${suffix}-${sequence}` },
        now,
        randomUUID(),
      )

    const createCustomerOrderAttempt = async (sequence: number) => {
      const { customer, quote } = await createCustomerQuote(sequence)
      return acceptQuote(customer.id, quote.id, sequence)
    }

    return { suffix, now, offering, createCustomerQuote, acceptQuote, createCustomerOrderAttempt }
  }

  it('decrements stock on hand exactly once for a single accepted order', async () => {
    const { offering, createCustomerOrderAttempt } = await seedStockTrackedOffering(3, 5)

    const order = await createCustomerOrderAttempt(1)
    expect(order.items[0]?.quantity).toBe(1)

    const persisted = await prisma.bakeryProductOffering.findUniqueOrThrow({
      where: { id: offering.id },
    })
    expect(persisted.stockOnHand).toBe(2)
  })

  it('rejects order acceptance with STOCK_UNAVAILABLE once stock is exhausted', async () => {
    const { offering, createCustomerOrderAttempt } = await seedStockTrackedOffering(1, 5)

    await createCustomerOrderAttempt(1)
    await expect(createCustomerOrderAttempt(2)).rejects.toMatchObject({
      code: 'STOCK_UNAVAILABLE',
      status: 422,
    })

    const persisted = await prisma.bakeryProductOffering.findUniqueOrThrow({
      where: { id: offering.id },
    })
    expect(persisted.stockOnHand).toBe(0)
  })

  it('never oversells the last unit under concurrent order acceptance', async () => {
    const { offering, createCustomerQuote, acceptQuote } = await seedStockTrackedOffering(1, 5)

    const first = await createCustomerQuote(1)
    const second = await createCustomerQuote(2)

    const results = await Promise.allSettled([
      acceptQuote(first.customer.id, first.quote.id, 1),
      acceptQuote(second.customer.id, second.quote.id, 2),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'STOCK_UNAVAILABLE',
    })

    const persisted = await prisma.bakeryProductOffering.findUniqueOrThrow({
      where: { id: offering.id },
    })
    expect(persisted.stockOnHand).toBe(0)
    expect(persisted.stockOnHand).not.toBeLessThan(0)
  })
})
