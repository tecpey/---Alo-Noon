import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const internalTenantId = '00000000-0000-4000-8000-000000000001'

async function main(): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${internalTenantId}, true)`
    const city = await transaction.city.upsert({
      where: { code: 'BABOL' },
      update: {},
      create: { tenantId: internalTenantId, code: 'BABOL', nameFa: 'بابل', isActive: true },
    })

    const zone = await transaction.operationalZone.upsert({
      where: { cityId_code: { cityId: city.id, code: 'BABOL-PILOT' } },
      update: {},
      create: {
        tenantId: internalTenantId,
        cityId: city.id,
        code: 'BABOL-PILOT',
        nameFa: 'محدوده پایلوت بابل',
        isActive: true,
      },
    })

    await transaction.serviceArea.upsert({
      where: { operationalZoneId_code: { operationalZoneId: zone.id, code: 'PILOT-CORE' } },
      update: {},
      create: {
        tenantId: internalTenantId,
        operationalZoneId: zone.id,
        code: 'PILOT-CORE',
        nameFa: 'هسته آزمایشی پایلوت',
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

    const bakery = await transaction.bakery.upsert({
      where: { agreementRef: 'development-bakery-agreement' },
      update: {},
      create: {
        tenantId: internalTenantId,
        legalName: 'Development Bakery Partner',
        displayNameFa: 'نانوایی آزمایشی توسعه',
        partnerStatus: 'ONBOARDING',
        agreementRef: 'development-bakery-agreement',
      },
    })

    const branch = await transaction.bakeryBranch.upsert({
      where: { cityId_code: { cityId: city.id, code: 'DEV-BRANCH' } },
      update: {},
      create: {
        tenantId: internalTenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: 'DEV-BRANCH',
        nameFa: 'شعبه آزمایشی توسعه',
        addressLine: 'نشانی غیرواقعی ویژه محیط توسعه',
        latitude: 36.5387,
        longitude: 52.6765,
        operationalStatus: 'ONBOARDING',
        qualityStatus: 'PENDING_REVIEW',
      },
    })

    const category = await transaction.productCategory.upsert({
      where: { code: 'SIGNATURE_BREAD' },
      update: {},
      create: { tenantId: internalTenantId, code: 'SIGNATURE_BREAD', nameFa: 'نان امضادار' },
    })

    const product = await transaction.product.upsert({
      where: { slug: 'development-signature-bread' },
      update: {},
      create: {
        tenantId: internalTenantId,
        categoryId: category.id,
        slug: 'development-signature-bread',
        nameFa: 'نان امضادار آزمایشی',
        descriptionFa: 'داده غیرواقعی برای توسعه و اعتبارسنجی مدل دامنه',
        lifecycle: 'DRAFT',
      },
    })

    const variant = await transaction.productVariant.upsert({
      where: { sku: 'DEV-SIGNATURE-001' },
      update: {},
      create: {
        tenantId: internalTenantId,
        productId: product.id,
        sku: 'DEV-SIGNATURE-001',
        nameFa: 'نسخه آزمایشی',
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
        lifecycle: 'DRAFT',
      },
    })

    await transaction.bakeryProductOffering.upsert({
      where: {
        bakeryBranchId_productVariantId: {
          bakeryBranchId: branch.id,
          productVariantId: variant.id,
        },
      },
      update: {},
      create: {
        tenantId: internalTenantId,
        bakeryBranchId: branch.id,
        productVariantId: variant.id,
        priceAmount: 250_000n,
        priceCurrency: 'IRR',
        availability: 'DRAFT',
        dailyCapacity: 20,
        preparationMinutes: 30,
      },
    })
  })
  console.log('Seeded development-only Babol domain references')
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
