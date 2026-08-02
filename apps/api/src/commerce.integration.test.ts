import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaCommerceRepository } from './modules/commerce'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantId = '00000000-0000-4000-8000-000000000001'
const created = {
  customerId: '',
  cityId: '',
  zoneId: '',
  serviceAreaId: '',
  addressId: '',
  pricingRuleId: '',
  bakeryId: '',
  branchId: '',
  categoryId: '',
  productId: '',
  variantId: '',
  offeringId: '',
}

afterEach(async () => {
  if (!created.customerId) return
  await prisma.quote.deleteMany({ where: { customerId: created.customerId } })
  await prisma.cart.deleteMany({ where: { customerId: created.customerId } })
  await prisma.domainEventOutbox.deleteMany({ where: { actorId: created.customerId } })
  await prisma.auditEvent.deleteMany({ where: { actorId: created.customerId } })
  await prisma.address.deleteMany({ where: { id: created.addressId } })
  await prisma.deliveryPricingRule.deleteMany({ where: { id: created.pricingRuleId } })
  await prisma.serviceArea.deleteMany({ where: { id: created.serviceAreaId } })
  await prisma.bakeryCapacitySlot.deleteMany({ where: { bakeryBranchId: created.branchId } })
  await prisma.bakeryProductOffering.deleteMany({ where: { id: created.offeringId } })
  await prisma.productVariant.deleteMany({ where: { id: created.variantId } })
  await prisma.product.deleteMany({ where: { id: created.productId } })
  await prisma.productCategory.deleteMany({ where: { id: created.categoryId } })
  await prisma.bakeryBranch.deleteMany({ where: { id: created.branchId } })
  await prisma.bakery.deleteMany({ where: { id: created.bakeryId } })
  await prisma.operationalZone.deleteMany({ where: { id: created.zoneId } })
  await prisma.city.deleteMany({ where: { id: created.cityId } })
  await prisma.customer.deleteMany({ where: { id: created.customerId } })
  for (const key of Object.keys(created) as Array<keyof typeof created>) created[key] = ''
})

afterAll(async () => prisma.$disconnect())

databaseDescribe('Prisma cart and quote transactions', () => {
  it('enforces optimistic concurrency, idempotent snapshots, supersession, and capacity', async () => {
    const suffix = randomUUID().slice(0, 8)
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        mobileE164: `+9891${suffix.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`,
        lifecycleStatus: 'ACTIVE',
      },
    })
    created.customerId = customer.id
    const city = await prisma.city.create({
      data: {
        tenantId,
        code: `CITY-${suffix}`,
        nameFa: 'شهر تست',
        isActive: true,
      },
    })
    created.cityId = city.id
    const zone = await prisma.operationalZone.create({
      data: {
        tenantId,
        cityId: city.id,
        code: `ZONE-${suffix}`,
        nameFa: 'محدوده تست',
        isActive: true,
      },
    })
    created.zoneId = zone.id
    const serviceArea = await prisma.serviceArea.create({
      data: {
        tenantId,
        operationalZoneId: zone.id,
        code: `AREA-${suffix}`,
        nameFa: 'محدوده خدمت تست',
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
        isActive: true,
      },
    })
    created.serviceAreaId = serviceArea.id
    const address = await prisma.address.create({
      data: {
        tenantId,
        customerId: customer.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        serviceAreaId: serviceArea.id,
        label: 'خانه',
        recipientName: 'مشتری تست',
        recipientPhoneE164: '+989111111111',
        addressLine: 'بابل، نشانی کامل تست برای تحویل نان',
        latitude: '36.5387',
        longitude: '52.6765',
        verificationState: 'CUSTOMER_CONFIRMED',
      },
    })
    created.addressId = address.id
    const pricingRule = await prisma.deliveryPricingRule.create({
      data: {
        tenantId,
        cityId: city.id,
        operationalZoneId: zone.id,
        version: 1,
        calculationMode: 'FLAT',
        baseFeeAmount: 50_000n,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        isActive: true,
      },
    })
    created.pricingRuleId = pricingRule.id
    const bakery = await prisma.bakery.create({
      data: {
        tenantId,
        legalName: `Bakery ${suffix}`,
        displayNameFa: 'نانوایی تست',
        partnerStatus: 'ACTIVE',
      },
    })
    created.bakeryId = bakery.id
    const branch = await prisma.bakeryBranch.create({
      data: {
        tenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `BRANCH-${suffix}`,
        nameFa: 'شعبه تست',
        addressLine: 'نشانی تست',
        latitude: '36.5442',
        longitude: '52.6781',
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    created.branchId = branch.id
    const category = await prisma.productCategory.create({
      data: {
        tenantId,
        code: `CAT-${suffix}`,
        nameFa: 'دسته تست',
      },
    })
    created.categoryId = category.id
    const product = await prisma.product.create({
      data: {
        tenantId,
        categoryId: category.id,
        slug: `product-${suffix}`,
        nameFa: 'بربری ویژه تست',
        lifecycle: 'ACTIVE',
      },
    })
    created.productId = product.id
    const variant = await prisma.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        sku: `SKU-${suffix}`,
        nameFa: 'بربری ویژه تست',
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
    created.variantId = variant.id
    const offering = await prisma.bakeryProductOffering.create({
      data: {
        tenantId,
        bakeryBranchId: branch.id,
        productVariantId: variant.id,
        priceAmount: 250000n,
        availability: 'AVAILABLE',
        dailyCapacity: 20,
      },
    })
    created.offeringId = offering.id

    const repository = createPrismaCommerceRepository(prisma)
    const now = new Date('2026-07-29T12:00:00.000Z')
    const firstCart = await repository.upsertItem(
      tenantId,
      customer.id,
      offering.id,
      { cityId: city.id, operationalZoneId: zone.id, quantity: 2 },
      now,
      randomUUID(),
    )
    expect(firstCart).toMatchObject({
      version: 1,
      subtotal: { amount: '500000', currency: 'IRR' },
    })
    await expect(
      repository.upsertItem(
        tenantId,
        customer.id,
        offering.id,
        {
          cityId: city.id,
          operationalZoneId: zone.id,
          quantity: 21,
          expectedCartVersion: 1,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' })

    const concurrent = await Promise.allSettled([
      repository.upsertItem(
        tenantId,
        customer.id,
        offering.id,
        {
          cityId: city.id,
          operationalZoneId: zone.id,
          quantity: 3,
          expectedCartVersion: 1,
        },
        now,
        randomUUID(),
      ),
      repository.upsertItem(
        tenantId,
        customer.id,
        offering.id,
        {
          cityId: city.id,
          operationalZoneId: zone.id,
          quantity: 4,
          expectedCartVersion: 1,
        },
        now,
        randomUUID(),
      ),
    ])
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (concurrent.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'CART_VERSION_CONFLICT' })

    const currentCart = await repository.getCart(tenantId, customer.id)
    expect(currentCart?.version).toBe(2)
    const idempotencyKey = `quote-${randomUUID()}`
    const quote = await repository.createQuote(
      tenantId,
      customer.id,
      { deliveryAddressId: address.id, expectedCartVersion: 2, idempotencyKey },
      now,
      randomUUID(),
    )
    const replay = await repository.createQuote(
      tenantId,
      customer.id,
      { deliveryAddressId: address.id, expectedCartVersion: 2, idempotencyKey },
      now,
      randomUUID(),
    )
    expect(replay.id).toBe(quote.id)
    expect(replay.total.amount).toMatch(/^(800000|1050000)$/)

    const changedCart = await repository.upsertItem(
      tenantId,
      customer.id,
      offering.id,
      {
        cityId: city.id,
        operationalZoneId: zone.id,
        quantity: 1,
        expectedCartVersion: 2,
      },
      now,
      randomUUID(),
    )
    expect(changedCart.version).toBe(3)
    const superseded = await repository.createQuote(
      tenantId,
      customer.id,
      { deliveryAddressId: address.id, expectedCartVersion: 2, idempotencyKey },
      now,
      randomUUID(),
    )
    expect(superseded.status).toBe('SUPERSEDED')

    await prisma.bakeryCapacitySlot.create({
      data: {
        tenantId,
        bakeryBranchId: branch.id,
        serviceDate: new Date('2026-07-29T00:00:00.000Z'),
        maxOrders: 1,
        reservedOrders: 1,
      },
    })
    await expect(
      repository.createQuote(
        tenantId,
        customer.id,
        {
          deliveryAddressId: address.id,
          expectedCartVersion: 3,
          idempotencyKey: `quote-${randomUUID()}`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' })
  })
})
