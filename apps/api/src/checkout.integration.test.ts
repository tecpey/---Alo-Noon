import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaCommerceRepository } from './modules/commerce'
import { createPrismaAddressRepository } from './modules/addresses'
import { createPrismaOrderRepository } from './modules/orders'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantId = '00000000-0000-4000-8000-000000000001'
const tracked = {
  customers: [] as string[],
  addresses: [] as string[],
  carts: [] as string[],
  quotes: [] as string[],
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
  tracked.addresses = []
  tracked.carts = []
  tracked.quotes = []
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

databaseDescribe('Phase 2E checkout transaction', () => {
  it('converts complete quotes atomically and arbitrates the last durable capacity', async () => {
    const suffix = randomUUID().slice(0, 8)
    const now = new Date('2026-08-02T10:00:00.000Z')
    const city = await prisma.city.create({
      data: {
        tenantId,
        code: `CHECKOUT-${suffix}`,
        nameFa: 'شهر تست پرداخت',
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
        legalName: `Checkout Bakery ${suffix}`,
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
      data: {
        tenantId,
        code: `CHECKOUT-CAT-${suffix}`,
        nameFa: 'دسته تست',
      },
    })
    tracked.categoryId = category.id
    const product = await prisma.product.create({
      data: {
        tenantId,
        categoryId: category.id,
        slug: `checkout-product-${suffix}`,
        nameFa: 'محصول تست',
        lifecycle: 'ACTIVE',
      },
    })
    tracked.productId = product.id
    const variant = await prisma.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        sku: `CHECKOUT-SKU-${suffix}`,
        nameFa: 'گونه تست',
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
    tracked.variantId = variant.id
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
        minimumOrderAmount: 200_000n,
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
        serviceDate: new Date('2026-08-02T00:00:00.000Z'),
        maxOrders: 2,
        reservedOrders: 0,
      },
    })
    tracked.capacitySlotId = capacity.id

    const commerce = createPrismaCommerceRepository(prisma)
    const addressRepository = createPrismaAddressRepository(prisma)
    const createCustomerQuote = async (sequence: number) => {
      const customer = await prisma.customer.create({
        data: {
          tenantId,
          mobileE164: `+9891${String(sequence).padStart(8, '0')}`,
          lifecycleStatus: 'ACTIVE',
        },
      })
      tracked.customers.push(customer.id)
      const addressInput = {
        cityId: city.id,
        idempotencyKey: `address-${suffix}-${sequence}`,
        label: 'خانه',
        recipientName: `مشتری ${sequence}`,
        recipientPhone: '+989111111111',
        addressLine: `نشانی immutable شماره ${sequence} برای تحویل`,
        latitude: 36.5387,
        longitude: 52.6765,
      }
      const address = await addressRepository.create(
        tenantId,
        customer.id,
        addressInput,
        now,
        randomUUID(),
      )
      tracked.addresses.push(address.id)
      const cart = await commerce.upsertItem(
        tenantId,
        customer.id,
        offering.id,
        {
          cityId: city.id,
          operationalZoneId: zone.id,
          quantity: 2,
        },
        now,
        randomUUID(),
      )
      tracked.carts.push(cart.id)
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
      tracked.quotes.push(quote.id)
      return { customer, address, addressInput, cart, quote }
    }

    const first = await createCustomerQuote(101)
    const second = await createCustomerQuote(102)
    const third = await createCustomerQuote(103)
    expect(first.quote.deliveryFee.amount).toBe('30000')
    expect(first.quote.total.amount).toBe('530000')
    expect(first.quote.deliveryDistanceMeters).toBeGreaterThan(0)
    expect(await addressRepository.list(tenantId, first.customer.id)).toHaveLength(1)
    expect(
      (
        await addressRepository.create(
          tenantId,
          first.customer.id,
          first.addressInput,
          now,
          randomUUID(),
        )
      ).id,
    ).toBe(first.address.id)
    await expect(
      addressRepository.create(
        tenantId,
        first.customer.id,
        {
          cityId: city.id,
          idempotencyKey: `address-${suffix}-101`,
          label: 'محل کار',
          recipientName: 'مشتری 101',
          recipientPhone: '+989111111111',
          addressLine: 'نشانی متفاوت و ناسازگار برای همان کلید',
          latitude: 36.5387,
          longitude: 52.6765,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })

    await prisma.address.update({
      where: { id: first.address.id },
      data: { addressLine: 'نشانی جدید که نباید وارد سفارش شود' },
    })
    await prisma.bakery.update({
      where: { id: bakery.id },
      data: { displayNameFa: 'نام جدید که نباید وارد سفارش شود' },
    })
    await expect(
      prisma.deliveryPricingRule.update({
        where: { id: pricingRule.id },
        data: { baseFeeAmount: 1n },
      }),
    ).rejects.toThrow()

    const failingOrders = createPrismaOrderRepository(prisma, {
      beforeCommit: async () => {
        throw new Error('INJECTED_ROLLBACK')
      },
    })
    await expect(
      failingOrders.create(
        tenantId,
        first.customer.id,
        {
          quoteId: first.quote.id,
          idempotencyKey: `order-${suffix}-first`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('INJECTED_ROLLBACK')
    expect(await prisma.order.count({ where: { quoteId: first.quote.id } })).toBe(0)
    expect(
      (await prisma.bakeryCapacitySlot.findUnique({ where: { id: capacity.id } }))?.reservedOrders,
    ).toBe(0)
    expect((await prisma.quote.findUnique({ where: { id: first.quote.id } }))?.status).toBe(
      'ACTIVE',
    )
    expect((await prisma.cart.findUnique({ where: { id: first.cart.id } }))?.state).toBe('ACTIVE')
    expect(
      await prisma.domainEventOutbox.count({
        where: { name: 'order.created', actorId: first.customer.id },
      }),
    ).toBe(0)
    expect(
      await prisma.auditEvent.count({
        where: { action: 'order.created', actorId: first.customer.id },
      }),
    ).toBe(0)

    const orders = createPrismaOrderRepository(prisma)
    await expect(
      orders.create(
        tenantId,
        first.customer.id,
        {
          quoteId: second.quote.id,
          idempotencyKey: `order-${suffix}-foreign-customer`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' })
    await prisma.address.update({ where: { id: third.address.id }, data: { archivedAt: now } })
    await expect(
      orders.create(
        tenantId,
        third.customer.id,
        { quoteId: third.quote.id, idempotencyKey: `order-${suffix}-archived-address` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'QUOTE_DEPENDENCY_UNAVAILABLE' })
    await prisma.address.update({ where: { id: third.address.id }, data: { archivedAt: null } })
    const firstKey = `order-${suffix}-first`
    const sameQuote = await Promise.all([
      orders.create(
        tenantId,
        first.customer.id,
        { quoteId: first.quote.id, idempotencyKey: firstKey },
        now,
        randomUUID(),
      ),
      orders.create(
        tenantId,
        first.customer.id,
        { quoteId: first.quote.id, idempotencyKey: firstKey },
        now,
        randomUUID(),
      ),
    ])
    expect(sameQuote[0].id).toBe(sameQuote[1].id)

    const lastCapacity = await Promise.allSettled([
      orders.create(
        tenantId,
        second.customer.id,
        {
          quoteId: second.quote.id,
          idempotencyKey: `order-${suffix}-second`,
        },
        now,
        randomUUID(),
      ),
      orders.create(
        tenantId,
        third.customer.id,
        {
          quoteId: third.quote.id,
          idempotencyKey: `order-${suffix}-third`,
        },
        now,
        randomUUID(),
      ),
    ])
    expect(lastCapacity.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(lastCapacity.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (lastCapacity.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'CAPACITY_UNAVAILABLE' })

    const persisted = await prisma.order.findUnique({
      where: { id: sameQuote[0].id },
      include: { items: true, transitions: true },
    })
    expect(persisted).toMatchObject({
      quoteId: first.quote.id,
      bakeryCapacitySlotId: capacity.id,
      state: 'PENDING_CONFIRMATION',
      paymentState: 'NOT_STARTED',
      productionState: 'UNSCHEDULED',
      deliveryState: 'UNASSIGNED',
      bakeryNameSnapshot: 'نانوایی تست',
      deliveryAddressSnapshot: `نشانی immutable شماره 101 برای تحویل`,
      subtotalAmount: 500_000n,
      deliveryFeeAmount: 30_000n,
      totalAmount: 530_000n,
    })
    expect(persisted?.items[0]).toMatchObject({
      productNameFaSnapshot: 'محصول تست',
      variantNameFaSnapshot: 'گونه تست',
      unitPriceAmount: 250_000n,
      lineTotalAmount: 500_000n,
    })
    expect(persisted?.transitions).toHaveLength(1)
    expect(persisted?.transitions[0]).toMatchObject({
      fromState: 'DRAFT',
      toState: 'PENDING_CONFIRMATION',
      actorType: 'CUSTOMER',
    })
    expect(
      (await prisma.bakeryCapacitySlot.findUnique({ where: { id: capacity.id } }))?.reservedOrders,
    ).toBe(2)
    expect(
      await prisma.domainEventOutbox.count({
        where: { name: 'order.created', actorId: { in: tracked.customers } },
      }),
    ).toBe(2)
    expect(
      await prisma.auditEvent.count({
        where: { action: 'order.created', actorId: { in: tracked.customers } },
      }),
    ).toBe(2)
    expect((await prisma.quote.findUnique({ where: { id: first.quote.id } }))?.status).toBe(
      'ACCEPTED',
    )
    expect((await prisma.cart.findUnique({ where: { id: first.cart.id } }))?.state).toBe(
      'CONVERTED',
    )

    await expect(
      orders.create(
        tenantId,
        first.customer.id,
        {
          quoteId: second.quote.id,
          idempotencyKey: firstKey,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await expect(
      orders.create(
        tenantId,
        first.customer.id,
        {
          quoteId: first.quote.id,
          idempotencyKey: `order-${suffix}-different`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'QUOTE_ALREADY_ACCEPTED' })
  })
})
