/**
 * Brings up one tenant that can actually take an order.
 *
 * The repository's own seed deliberately leaves everything DRAFT/ONBOARDING —
 * useful for exercising the schema, useless for a launch, because nothing in
 * that state is sellable. This creates the ACTIVE versions plus the pieces the
 * seed never touches at all: the tenant row itself, the host that resolves to
 * it, a delivery pricing rule, capacity for today, and the chart of accounts.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS, ADMIN_ROLES } from '@alo-noon/domain'

import { createPrismaFinancialOperationsService } from '../src/modules/financial-operations'

const prisma = new PrismaClient()
const now = new Date()

const TENANT_ID = '00000000-0000-4000-8000-000000000001'
const OPERATOR_MOBILE = '+989120000001'
const COURIER_MOBILE = '+989120000002'
const CUSTOMER_MOBILE = '+989120000003'

/**
 * The categories a customer sees as chips on the storefront.
 *
 * They are rows rather than a hard-coded list in the web app, because the shop
 * has to be able to add "شیرینی" without a deploy. The codes are what the
 * catalog API returns; the Persian names are what a customer reads.
 */
const LAUNCH_CATEGORIES = [
  { code: 'SPECIAL', nameFa: 'پخت ویژه' },
  { code: 'BARBARI', nameFa: 'بربری' },
  { code: 'SANGAK', nameFa: 'سنگک' },
  { code: 'LAVASH', nameFa: 'لواش' },
  { code: 'TAFTOON', nameFa: 'تافتون' },
  { code: 'SWEET', nameFa: 'شیرینی و کماج' },
] as const

interface LaunchBread {
  readonly slug: string
  readonly sku: string
  readonly nameFa: string
  readonly variantNameFa: string
  readonly descriptionFa: string
  readonly categoryCode: (typeof LAUNCH_CATEGORIES)[number]['code']
  /** FRESH is baked on the order; PACKAGED is already sealed on the shelf. */
  readonly kind: 'FRESH' | 'PACKAGED'
  /** Rial, as the ledger holds it. Toman is a display shift, never a division. */
  readonly priceRial: bigint
  readonly prepareMinutes: number
  readonly dailyCapacity: number
  readonly ingredients: readonly string[]
  readonly allergens: readonly string[]
}

/**
 * The bread this shop actually opens with.
 *
 * The slugs, names and prices are the ones on the storefront, so the page and
 * the database cannot disagree about what is for sale or what it costs. Gluten
 * is declared on every wheat bread: an allergen list that is empty because
 * nobody filled it in reads exactly like an allergen list that is empty because
 * there are none.
 */
const LAUNCH_CATALOG: readonly LaunchBread[] = [
  {
    slug: 'komaj-gerdooyi',
    sku: 'KOMAJ-GERDOOYI',
    nameFa: 'کماج گردویی',
    variantNameFa: 'کماج گردویی، یک عدد',
    descriptionFa: 'کماج نرم با مغز گردو و روکش کنجد، تازه از تنور.',
    categoryCode: 'SWEET',
    kind: 'FRESH',
    priceRial: 280_000n,
    prepareMinutes: 40,
    dailyCapacity: 30,
    ingredients: ['آرد گندم', 'گردو', 'کنجد', 'شکر', 'مخمر', 'نمک'],
    allergens: ['گلوتن', 'مغز گردو', 'کنجد'],
  },
  {
    slug: 'sangak-konjedi',
    sku: 'SANGAK-KONJEDI',
    nameFa: 'نان سنگک کنجدی',
    variantNameFa: 'سنگک کنجدی، یک نان',
    descriptionFa: 'سنگک سنتی روی سنگ داغ، با کنجد فراوان.',
    categoryCode: 'SANGAK',
    kind: 'FRESH',
    priceRial: 95_000n,
    prepareMinutes: 30,
    dailyCapacity: 80,
    ingredients: ['آرد کامل گندم', 'کنجد', 'خمیرترش', 'نمک'],
    allergens: ['گلوتن', 'کنجد'],
  },
  {
    slug: 'barbari-konjedi',
    sku: 'BARBARI-KONJEDI',
    nameFa: 'نان بربری کنجدی',
    variantNameFa: 'بربری کنجدی، یک نان',
    descriptionFa: 'بربری تازه با رویهٔ کنجدی و مغز نرم.',
    categoryCode: 'BARBARI',
    kind: 'FRESH',
    priceRial: 70_000n,
    prepareMinutes: 30,
    dailyCapacity: 80,
    ingredients: ['آرد گندم', 'کنجد', 'مخمر', 'نمک'],
    allergens: ['گلوتن', 'کنجد'],
  },
  {
    slug: 'lavash',
    sku: 'LAVASH-PACKAGED',
    nameFa: 'لواش',
    variantNameFa: 'لواش بسته‌بندی‌شده',
    descriptionFa: 'لواش نازک در بسته‌بندی بهداشتی.',
    categoryCode: 'LAVASH',
    kind: 'PACKAGED',
    priceRial: 50_000n,
    prepareMinutes: 10,
    dailyCapacity: 200,
    ingredients: ['آرد گندم', 'مخمر', 'نمک'],
    allergens: ['گلوتن'],
  },
  {
    slug: 'taftoon',
    sku: 'TAFTOON-PACKAGED',
    nameFa: 'نان تافتون',
    variantNameFa: 'تافتون بسته‌بندی‌شده',
    descriptionFa: 'تافتون نرم در بسته‌بندی بهداشتی.',
    categoryCode: 'TAFTOON',
    kind: 'PACKAGED',
    priceRial: 60_000n,
    prepareMinutes: 10,
    dailyCapacity: 200,
    ingredients: ['آرد گندم', 'مخمر', 'نمک'],
    allergens: ['گلوتن'],
  },
  {
    slug: 'sangak',
    sku: 'SANGAK-PLAIN',
    nameFa: 'نان سنگک',
    variantNameFa: 'سنگک بسته‌بندی‌شده',
    descriptionFa: 'سنگک ساده در بسته‌بندی بهداشتی.',
    categoryCode: 'SANGAK',
    kind: 'PACKAGED',
    priceRial: 65_000n,
    prepareMinutes: 10,
    dailyCapacity: 150,
    ingredients: ['آرد کامل گندم', 'خمیرترش', 'نمک'],
    allergens: ['گلوتن'],
  },
  {
    slug: 'barbari',
    sku: 'BARBARI-PACKAGED',
    nameFa: 'نان بربری',
    variantNameFa: 'بربری بسته‌بندی‌شده',
    descriptionFa: 'بربری ساده در بسته‌بندی بهداشتی.',
    categoryCode: 'BARBARI',
    kind: 'PACKAGED',
    priceRial: 60_000n,
    prepareMinutes: 10,
    dailyCapacity: 150,
    ingredients: ['آرد گندم', 'مخمر', 'نمک'],
    allergens: ['گلوتن'],
  },
]

/** The pilot city's timezone, and the clock every service date is read on. */
const CITY_TIMEZONE = 'Asia/Tehran'

/**
 * The service date for a moment, in a city's own timezone.
 *
 * Deliberately the same rule as the API's `serviceDateAt`. A bootstrap that
 * dates its capacity slots differently from the code that looks them up seeds a
 * shop that cannot take orders, and does it only during the hours when the two
 * calendars disagree — which is the hardest kind of bug to catch by hand.
 */
function serviceDateIn(moment: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(moment)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`)
}

async function tenantTransaction<T>(
  run: (t: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`
    return run(transaction)
  })
}

async function main(): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: { status: 'ACTIVE' },
    create: { id: TENANT_ID, slug: 'alo-noon', name: 'الو نون', status: 'ACTIVE' },
  })

  // Tenant identity comes from the host, and Fastify's `request.hostname` may or
  // may not carry the port depending on the deployment, so both forms resolve.
  for (const host of ['localhost', 'localhost:3001', '127.0.0.1', '127.0.0.1:3001']) {
    await prisma.tenantDomain.upsert({
      where: { host },
      update: { verifiedAt: now },
      create: { tenantId: TENANT_ID, host, isPrimary: host === 'localhost', verifiedAt: now },
    })
  }

  const ids = await tenantTransaction(async (t) => {
    const city = await t.city.upsert({
      where: { code: 'BABOL' },
      update: { isActive: true },
      create: { tenantId: TENANT_ID, code: 'BABOL', nameFa: 'بابل', isActive: true },
    })
    const zone = await t.operationalZone.upsert({
      where: { cityId_code: { cityId: city.id, code: 'BABOL-PILOT' } },
      update: { isActive: true },
      create: {
        tenantId: TENANT_ID,
        cityId: city.id,
        code: 'BABOL-PILOT',
        nameFa: 'محدوده پایلوت بابل',
        isActive: true,
      },
    })
    const area = await t.serviceArea.upsert({
      where: { operationalZoneId_code: { operationalZoneId: zone.id, code: 'PILOT-CORE' } },
      update: { isActive: true },
      create: {
        tenantId: TENANT_ID,
        operationalZoneId: zone.id,
        code: 'PILOT-CORE',
        nameFa: 'هستهٔ پایلوت',
        isActive: true,
        boundaryGeoJson: {
          type: 'Polygon',
          coordinates: [
            [
              [52.62, 36.5],
              [52.73, 36.5],
              [52.73, 36.59],
              [52.62, 36.59],
              [52.62, 36.5],
            ],
          ],
        },
      },
    })
    const bakery = await t.bakery.upsert({
      where: { agreementRef: 'alo-noon-pilot-agreement' },
      update: { partnerStatus: 'ACTIVE' },
      create: {
        tenantId: TENANT_ID,
        legalName: 'نانوایی سنگک بابل',
        displayNameFa: 'نان سنگک بابل',
        partnerStatus: 'ACTIVE',
        agreementRef: 'alo-noon-pilot-agreement',
      },
    })
    const branch = await t.bakeryBranch.upsert({
      where: { cityId_code: { cityId: city.id, code: 'BABOL-1' } },
      update: { operationalStatus: 'ACTIVE', qualityStatus: 'APPROVED' },
      create: {
        tenantId: TENANT_ID,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: 'BABOL-1',
        nameFa: 'شعبهٔ مرکزی',
        addressLine: 'بابل، خیابان مدرس',
        latitude: 36.5387,
        longitude: 52.6765,
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
    const categoryIds = new Map<string, string>()
    for (const definition of LAUNCH_CATEGORIES) {
      const category = await t.productCategory.upsert({
        where: { code: definition.code },
        update: { nameFa: definition.nameFa },
        create: { tenantId: TENANT_ID, ...definition },
      })
      categoryIds.set(definition.code, category.id)
    }

    const offeringIds = new Map<string, string>()
    for (const bread of LAUNCH_CATALOG) {
      const categoryId = categoryIds.get(bread.categoryCode)
      if (!categoryId) throw new Error(`Unknown category ${bread.categoryCode} for ${bread.slug}`)

      // Every mutable field is repeated in `update`, so re-running this against
      // a database seeded by an older version of the script corrects the rows
      // rather than leaving whatever it found. A bootstrap that only fixes an
      // empty database is a bootstrap you cannot trust twice.
      const product = await t.product.upsert({
        where: { slug: bread.slug },
        update: {
          categoryId,
          nameFa: bread.nameFa,
          descriptionFa: bread.descriptionFa,
          lifecycle: 'ACTIVE',
        },
        create: {
          tenantId: TENANT_ID,
          categoryId,
          slug: bread.slug,
          nameFa: bread.nameFa,
          descriptionFa: bread.descriptionFa,
          lifecycle: 'ACTIVE',
        },
      })

      const fresh = bread.kind === 'FRESH'
      // The two shapes are kept apart rather than merged behind ternaries
      // because `validateProductClassification` treats them as two different
      // things: a signature bread carries freshness windows and no packaging, a
      // packaged one carries a shelf life and may not claim to be fresh. A row
      // that mixes them is rejected by the domain, not by the database.
      const variantShape = fresh
        ? {
            nameFa: bread.variantNameFa,
            fulfillmentClass: 'SIGNATURE_FRESH' as const,
            freshnessClaim: 'FRESHLY_PRODUCED' as const,
            productionMode: 'MADE_TO_ORDER' as const,
            fulfillmentControl: 'CONTROLLED_PICKUP' as const,
            packagingType: null,
            shelfLifeMinutes: null,
            productionWindowMinutes: bread.prepareMinutes,
            pickupWithinMinutes: 15,
            freshnessWindowMinutes: 90,
            ingredients: [...bread.ingredients],
            allergens: [...bread.allergens],
            dietaryAttributes: [],
            lifecycle: 'ACTIVE' as const,
          }
        : {
            nameFa: bread.variantNameFa,
            fulfillmentClass: 'PACKAGED_TRADITIONAL' as const,
            freshnessClaim: 'PACKAGED' as const,
            // Already on the shelf: the branch picks it, it does not bake it.
            productionMode: 'READY_STOCK' as const,
            fulfillmentControl: 'PLATFORM_STOCK' as const,
            packagingType: 'ALO_NOON_SEALED' as const,
            shelfLifeMinutes: 1_440,
            productionWindowMinutes: null,
            pickupWithinMinutes: null,
            freshnessWindowMinutes: null,
            ingredients: [...bread.ingredients],
            allergens: [...bread.allergens],
            dietaryAttributes: [],
            lifecycle: 'ACTIVE' as const,
          }
      const variant = await t.productVariant.upsert({
        where: { sku: bread.sku },
        update: variantShape,
        create: { tenantId: TENANT_ID, productId: product.id, sku: bread.sku, ...variantShape },
      })

      const offering = await t.bakeryProductOffering.upsert({
        where: {
          bakeryBranchId_productVariantId: {
            bakeryBranchId: branch.id,
            productVariantId: variant.id,
          },
        },
        update: {
          priceAmount: bread.priceRial,
          availability: 'AVAILABLE',
          dailyCapacity: bread.dailyCapacity,
          preparationMinutes: bread.prepareMinutes,
        },
        create: {
          tenantId: TENANT_ID,
          bakeryBranchId: branch.id,
          productVariantId: variant.id,
          priceAmount: bread.priceRial,
          priceCurrency: 'IRR',
          availability: 'AVAILABLE',
          dailyCapacity: bread.dailyCapacity,
          preparationMinutes: bread.prepareMinutes,
        },
      })
      offeringIds.set(bread.slug, offering.id)
    }

    const offeringId = offeringIds.get('sangak')
    if (!offeringId) throw new Error('The launch catalog seeded no sangak offering')

    // Capacity, or the branch cannot take an order at all.
    //
    // The service date is computed in the city's own timezone, exactly as
    // `serviceDateAt` does when an order is accepted. Using UTC here instead
    // looked right and was wrong for three and a half hours of every day: from
    // 20:30 UTC it is already tomorrow in Tehran, so the API looked for a slot
    // this script had never created and every evening order failed with
    // CAPACITY_UNAVAILABLE.
    //
    // A week is seeded rather than a single day, so a stack left running
    // overnight does not stop taking orders at midnight.
    for (let offset = 0; offset < 7; offset += 1) {
      const serviceDate = serviceDateIn(
        new Date(now.getTime() + offset * 86_400_000),
        CITY_TIMEZONE,
      )
      await t.bakeryCapacitySlot.upsert({
        where: { bakeryBranchId_serviceDate: { bakeryBranchId: branch.id, serviceDate } },
        update: { maxOrders: 100, suspended: false },
        create: {
          tenantId: TENANT_ID,
          bakeryBranchId: branch.id,
          serviceDate,
          maxOrders: 100,
          suspended: false,
        },
      })
    }

    // findFirst rather than upsert: the unique is over a nullable column, which
    // Prisma will not accept as a compound where key.
    const existingRule = await t.deliveryPricingRule.findFirst({
      where: { tenantId: TENANT_ID, cityId: city.id, operationalZoneId: zone.id, version: 1 },
    })
    if (!existingRule) {
      await t.deliveryPricingRule.create({
        data: {
          tenantId: TENANT_ID,
          cityId: city.id,
          operationalZoneId: zone.id,
          version: 1,
          calculationMode: 'FLAT',
          baseFeeAmount: 50_000n,
          currency: 'IRR',
          effectiveFrom: new Date(now.getTime() - 86_400_000),
          isActive: true,
        },
      })
    }

    return {
      cityId: city.id,
      zoneId: zone.id,
      areaId: area.id,
      branchId: branch.id,
      offeringId,
      offerings: Object.fromEntries(offeringIds),
    }
  })

  // Capture posts into the tenant's chart, so the chart has to exist first.
  await createPrismaFinancialOperationsService(prisma).provision(
    TENANT_ID,
    { idempotencyKey: 'alo-noon-launch-chart-of-accounts-v1' },
    now,
    randomUUID(),
  )

  // The SMS gateway. The credential reference points at a placeholder value:
  // nothing in this launch may text a real person.
  await tenantTransaction(async (t) => {
    const existing = await t.authDeliveryProviderConfiguration.findFirst({
      where: { tenantId: TENANT_ID, providerCode: 'LIMOSMS' },
    })
    if (!existing) {
      await t.authDeliveryProviderConfiguration.create({
        data: {
          tenantId: TENANT_ID,
          providerCode: 'LIMOSMS',
          adapterVersion: '1.0.0',
          adapterSpiVersion: 1,
          environment: 'TEST',
          credentialReference: 'env://AUTH_SMS_LIMOSMS_KEY',
          senderReference: '3000000000',
          templateReference: 'otp-fa',
          enabled: true,
          isDefault: true,
          priority: 100,
          healthStatus: 'HEALTHY',
        },
      })
    }
  })

  // Roles and permissions from the domain catalogue, so a granted role is one
  // the routes actually check.
  for (const definition of ADMIN_ROLES) {
    const role = await prisma.authorizationRole.upsert({
      where: { code: definition.code },
      update: {},
      create: { code: definition.code, name: definition.name },
    })
    for (const code of definition.permissions) {
      const permission = await prisma.authorizationPermission.upsert({
        where: { code },
        update: {},
        create: { code, description: `Permission ${code}` },
      })
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      })
    }
  }

  // The operator: an account, a membership, and every admin permission.
  const operator = await prisma.identityAccount.upsert({
    where: { mobileE164: OPERATOR_MOBILE },
    update: { status: 'ACTIVE' },
    create: { mobileE164: OPERATOR_MOBILE, status: 'ACTIVE', verifiedAt: now },
  })
  await tenantTransaction(async (t) => {
    const membership = await t.tenantMembership.findFirst({
      where: { tenantId: TENANT_ID, accountId: operator.id },
    })
    if (!membership) {
      await t.tenantMembership.create({
        data: { tenantId: TENANT_ID, accountId: operator.id, status: 'ACTIVE', activeAt: now },
      })
    }
  })
  const adminRole = await prisma.authorizationRole.findUniqueOrThrow({
    where: { code: 'TENANT_ADMIN' },
  })
  const grant = await prisma.accessGrant.findFirst({
    where: { accountId: operator.id, roleId: adminRole.id, revokedAt: null },
  })
  if (!grant) {
    await prisma.accessGrant.create({
      data: { accountId: operator.id, roleId: adminRole.id, scopeType: 'GLOBAL', activeAt: now },
    })
  }

  // The courier: an account plus a roster record carrying the same number.
  await prisma.identityAccount.upsert({
    where: { mobileE164: COURIER_MOBILE },
    update: { status: 'ACTIVE' },
    create: { mobileE164: COURIER_MOBILE, status: 'ACTIVE', verifiedAt: now },
  })
  await tenantTransaction(async (t) => {
    const partner = await t.courierPartner.upsert({
      where: { code: 'INHOUSE' },
      update: { isActive: true },
      create: {
        tenantId: TENANT_ID,
        code: 'INHOUSE',
        displayName: 'پیک‌های خودی',
        isActive: true,
      },
    })
    const existing = await t.courier.findFirst({
      where: { tenantId: TENANT_ID, mobileE164: COURIER_MOBILE },
    })
    if (!existing) {
      await t.courier.create({
        data: {
          tenantId: TENANT_ID,
          courierPartnerId: partner.id,
          mobileE164: COURIER_MOBILE,
          displayName: 'رضا پیک',
          status: 'AVAILABLE',
        },
      })
    }
  })

  console.log(
    JSON.stringify(
      {
        tenantId: TENANT_ID,
        ...ids,
        operatorMobile: OPERATOR_MOBILE,
        courierMobile: COURIER_MOBILE,
        customerMobile: CUSTOMER_MOBILE,
        permissions: Object.values(ADMIN_PERMISSIONS).length,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
