import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import {
  AdminCatalogError,
  createPrismaAdminCatalogService,
  type AdminCatalogService,
} from './modules/admin-catalog'

/**
 * Exercises catalogue authoring against PostgreSQL.
 *
 * The rules worth testing here are the ones that only hold when several rows
 * agree: an offering cannot go on sale unless its variant and product are both
 * active, a variant cannot be withdrawn while branches are still selling it,
 * and the permission that authorizes a write is re-read from live grant rows
 * rather than trusted from a session.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: AdminCatalogService = createPrismaAdminCatalogService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-07T10:00:00.000Z')

interface Fixture {
  tenantId: string
  categoryId: string
  branchId: string
  /** Holds admin.catalog.manage. */
  operatorId: string
  /** Signed in, but holds nothing. */
  outsiderId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('admin catalogue over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('refuses a write from an account without the catalogue permission', async () => {
    await expect(
      service.createProduct(
        fixture.tenantId,
        { accountId: fixture.outsiderId },
        {
          categoryId: fixture.categoryId,
          slug: `forbidden-${suffix.toLowerCase()}`,
          nameFa: 'ممنوع',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_FORBIDDEN', status: 403 })

    // And left nothing behind.
    const { totalItems } = await service.listProducts(fixture.tenantId, { page: 1, pageSize: 50 })
    expect(totalItems).toBe(0)
  })

  it('creates a product as a draft and audits who created it', async () => {
    const product = await service.createProduct(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      {
        categoryId: fixture.categoryId,
        slug: `barbari-${suffix.toLowerCase()}`,
        nameFa: 'بربری',
        descriptionFa: 'نان بربری تازه',
      },
      now,
      randomUUID(),
    )

    expect(product.lifecycle).toBe('DRAFT')
    expect(product.variants).toEqual([])
    expect(product.categoryNameFa).toBe('نان سنتی')

    const audit = await prisma.auditEvent.findFirst({
      where: {
        tenantId: fixture.tenantId,
        entityId: product.id,
        action: 'catalog.product_created',
      },
    })
    expect(audit?.actorId).toBe(fixture.operatorId)
    expect(audit?.actorType).toBe('STAFF')

    const outbox = await prisma.domainEventOutbox.findFirst({
      where: { tenantId: fixture.tenantId, aggregateId: product.id },
    })
    expect(outbox?.name).toBe('catalog.product_created')
  })

  it('refuses a classification the domain rejects, without writing a row', async () => {
    const product = await createDraftProduct('classification')

    await expect(
      service.createVariant(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        product.id,
        {
          sku: `BAD-${suffix}`,
          nameFa: 'ناسازگار',
          // A packaged class cannot claim fresh production.
          fulfillmentClass: 'PACKAGED_TRADITIONAL',
          freshnessClaim: 'FRESHLY_PRODUCED',
          productionMode: 'READY_STOCK',
          fulfillmentControl: 'PLATFORM_STOCK',
          ingredients: [],
          allergens: [],
          dietaryAttributes: [],
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_CLASSIFICATION_INVALID', status: 422 })

    const written = await prisma.productVariant.count({ where: { productId: product.id } })
    expect(written).toBe(0)
  })

  it('walks a product from draft to a priced, sellable offering', async () => {
    const product = await createDraftProduct('sellable')
    const variant = await service.createVariant(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      product.id,
      {
        sku: `SANGAK-${suffix}`,
        nameFa: 'سنگک ساده',
        fulfillmentClass: 'SIGNATURE_FRESH',
        freshnessClaim: 'FRESHLY_PRODUCED',
        productionMode: 'MADE_TO_ORDER',
        fulfillmentControl: 'CONTROLLED_PICKUP',
        productionWindowMinutes: 30,
        pickupWithinMinutes: 15,
        freshnessWindowMinutes: 90,
        ingredients: ['آرد', 'آب', 'نمک'],
        allergens: ['گلوتن'],
        dietaryAttributes: [],
      },
      now,
      randomUUID(),
    )
    expect(variant.lifecycle).toBe('DRAFT')

    const offering = await service.createOffering(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      {
        bakeryBranchId: fixture.branchId,
        productVariantId: variant.id,
        price: '250000',
        dailyCapacity: 40,
        preparationMinutes: 25,
        stockTracked: false,
        reason: 'قیمت‌گذاری اولیه سنگک',
      },
      now,
      randomUUID(),
    )
    // A new offering is never immediately for sale.
    expect(offering.availability).toBe('DRAFT')
    expect(offering.price.amount).toBe('250000')

    // Publishing it while the variant is still a draft must fail: the offering
    // row alone does not decide whether the catalogue agrees.
    await expect(publish(offering.id, 'انتشار زودهنگام')).rejects.toMatchObject({
      code: 'VARIANT_NOT_ACTIVE',
      status: 409,
    })

    await service.updateVariant(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      variant.id,
      { lifecycle: 'ACTIVE' },
      now,
      randomUUID(),
    )
    // The product is still a draft, so it is still refused — for the other reason.
    await expect(publish(offering.id, 'محصول هنوز پیش‌نویس')).rejects.toMatchObject({
      code: 'PRODUCT_NOT_ACTIVE',
      status: 409,
    })

    await service.updateProduct(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      product.id,
      { lifecycle: 'ACTIVE' },
      now,
      randomUUID(),
    )
    const published = await publish(offering.id, 'آمادهٔ فروش')
    expect(published.availability).toBe('AVAILABLE')
  })

  it('records the old price alongside the new one when a price changes', async () => {
    const offering = await liveOffering('repricing')

    // A minute later than publication, so "the most recent event" is unambiguous.
    const later = new Date(now.getTime() + 60_000)
    const raised = await service.updateOffering(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      offering.id,
      { price: '310000', reason: 'افزایش قیمت آرد' },
      later,
      randomUUID(),
    )
    expect(raised.price.amount).toBe('310000')

    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: offering.id, action: 'catalog.offering_updated' },
      orderBy: { occurredAt: 'desc' },
    })
    const payload = await prisma.domainEventOutbox.findFirst({
      where: { aggregateId: offering.id, name: 'catalog.offering_updated' },
      orderBy: { occurredAt: 'desc' },
    })
    expect(audit).not.toBeNull()
    // Without the old price on the event, nobody can later explain a charge.
    expect(payload?.payload).toMatchObject({ fromPrice: '250000', toPrice: '310000' })
  })

  it('refuses to withdraw a variant that branches are still selling', async () => {
    const offering = await liveOffering('withdrawal')

    await expect(
      service.updateVariant(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        offering.productVariantId,
        { lifecycle: 'RETIRED', reason: 'حذف از منو' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'OFFERINGS_STILL_LIVE', status: 409 })

    // Pausing the offering first is what makes the withdrawal legitimate.
    await service.updateOffering(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      offering.id,
      { availability: 'PAUSED', reason: 'توقف پیش از حذف' },
      now,
      randomUUID(),
    )
    const retired = await service.updateVariant(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      offering.productVariantId,
      { lifecycle: 'RETIRED', reason: 'حذف از منو' },
      now,
      randomUUID(),
    )
    expect(retired.lifecycle).toBe('RETIRED')
  })

  it('refuses a second offering of the same variant at the same branch', async () => {
    const offering = await liveOffering('duplicate')

    await expect(
      service.createOffering(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        {
          bakeryBranchId: fixture.branchId,
          productVariantId: offering.productVariantId,
          price: '999000',
          stockTracked: false,
          reason: 'قیمت دوم',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'OFFERING_ALREADY_EXISTS', status: 409 })
  })

  it('refuses a lifecycle transition out of RETIRED', async () => {
    const product = await createDraftProduct('terminal')
    await service.updateProduct(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      product.id,
      { lifecycle: 'RETIRED', reason: 'کنار گذاشته شد' },
      now,
      randomUUID(),
    )

    await expect(
      service.updateProduct(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        product.id,
        { lifecycle: 'ACTIVE', reason: 'بازگشت' },
        now,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(AdminCatalogError)
  })

  it('keeps stock tracking and stock on hand in step', async () => {
    const offering = await liveOffering('stock')

    const tracked = await service.updateOffering(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      offering.id,
      { stock: { stockTracked: true, stockOnHand: 12 }, reason: 'شمارش موجودی' },
      now,
      randomUUID(),
    )
    expect(tracked.stockTracked).toBe(true)
    expect(tracked.stockOnHand).toBe(12)

    const untracked = await service.updateOffering(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      offering.id,
      { stock: { stockTracked: false, stockOnHand: null }, reason: 'بازگشت به تولید سفارشی' },
      now,
      randomUUID(),
    )
    expect(untracked.stockOnHand).toBeNull()
  })

  it('does not show one tenant the other tenant catalogue', async () => {
    const other = await prisma.tenant.create({
      data: { slug: `cat-other-${suffix.toLowerCase()}`, name: `Catalog other ${suffix}` },
    })
    const { totalItems } = await service.listProducts(other.id, { page: 1, pageSize: 50 })
    expect(totalItems).toBe(0)
  })
})

function publish(offeringId: string, reason: string): ReturnType<typeof service.updateOffering> {
  return service.updateOffering(
    fixture.tenantId,
    { accountId: fixture.operatorId },
    offeringId,
    { availability: 'AVAILABLE', reason },
    now,
    randomUUID(),
  )
}

async function createDraftProduct(
  label: string,
): Promise<Awaited<ReturnType<typeof service.createProduct>>> {
  return service.createProduct(
    fixture.tenantId,
    { accountId: fixture.operatorId },
    {
      categoryId: fixture.categoryId,
      slug: `${label}-${suffix.toLowerCase()}`,
      nameFa: `محصول ${label}`,
    },
    now,
    randomUUID(),
  )
}

/** A product, variant, and offering all the way to AVAILABLE. */
async function liveOffering(
  label: string,
): Promise<Awaited<ReturnType<typeof service.createOffering>>> {
  const product = await createDraftProduct(label)
  const variant = await service.createVariant(
    fixture.tenantId,
    { accountId: fixture.operatorId },
    product.id,
    {
      sku: `${label.toUpperCase()}-${suffix}`,
      nameFa: `گونهٔ ${label}`,
      fulfillmentClass: 'SIGNATURE_FRESH',
      freshnessClaim: 'FRESHLY_PRODUCED',
      productionMode: 'MADE_TO_ORDER',
      fulfillmentControl: 'CONTROLLED_PICKUP',
      productionWindowMinutes: 30,
      pickupWithinMinutes: 15,
      freshnessWindowMinutes: 90,
      ingredients: [],
      allergens: [],
      dietaryAttributes: [],
    },
    now,
    randomUUID(),
  )
  const offering = await service.createOffering(
    fixture.tenantId,
    { accountId: fixture.operatorId },
    {
      bakeryBranchId: fixture.branchId,
      productVariantId: variant.id,
      price: '250000',
      stockTracked: false,
      reason: `قیمت‌گذاری ${label}`,
    },
    now,
    randomUUID(),
  )
  const actor = { accountId: fixture.operatorId }
  await service.updateVariant(
    fixture.tenantId,
    actor,
    variant.id,
    { lifecycle: 'ACTIVE' },
    now,
    randomUUID(),
  )
  await service.updateProduct(
    fixture.tenantId,
    actor,
    product.id,
    { lifecycle: 'ACTIVE' },
    now,
    randomUUID(),
  )
  return publish(offering.id, `انتشار ${label}`)
}

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `catalog-${suffix.toLowerCase()}`, name: `Catalog ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `CAT-${suffix}`, nameFa: 'شهر کاتالوگ', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `CATZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Catalog Bakery ${suffix}`,
      displayNameFa: 'نانوایی کاتالوگ',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `CATB-${suffix}`,
      nameFa: 'شعبهٔ مرکزی',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const category = await prisma.productCategory.create({
    data: { tenantId, code: `CATC_${suffix}`, nameFa: 'نان سنتی' },
  })

  const operatorId = await createAccount(tenantId, [ADMIN_PERMISSIONS.catalogManage])
  const outsiderId = await createAccount(tenantId, [])

  return { tenantId, categoryId: category.id, branchId: branch.id, operatorId, outsiderId }
}

async function createAccount(tenantId: string, permissions: readonly string[]): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: {
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '4').slice(0, 9)}`,
      verifiedAt: now,
    },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.tenantMembership.create({
      data: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
    })
  })
  if (permissions.length === 0) return account.id

  const role = await prisma.authorizationRole.create({
    data: { code: `CATALOG_MANAGER_${suffix}`, name: 'Catalog manager' },
  })
  for (const code of permissions) {
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: `Integration permission ${code}` },
    })
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
  }
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })
  return account.id
}
