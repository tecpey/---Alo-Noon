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
    const category = await t.productCategory.upsert({
      where: { code: 'SIGNATURE_BREAD' },
      update: {},
      create: { tenantId: TENANT_ID, code: 'SIGNATURE_BREAD', nameFa: 'نان امضادار' },
    })
    const product = await t.product.upsert({
      where: { slug: 'sangak' },
      update: { lifecycle: 'ACTIVE' },
      create: {
        tenantId: TENANT_ID,
        categoryId: category.id,
        slug: 'sangak',
        nameFa: 'نان سنگک',
        descriptionFa: 'سنگک تازه از تنور',
        lifecycle: 'ACTIVE',
      },
    })
    const variant = await t.productVariant.upsert({
      where: { sku: 'SANGAK-PLAIN' },
      update: { lifecycle: 'ACTIVE' },
      create: {
        tenantId: TENANT_ID,
        productId: product.id,
        sku: 'SANGAK-PLAIN',
        nameFa: 'سنگک ساده',
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
        lifecycle: 'ACTIVE',
      },
    })
    const offering = await t.bakeryProductOffering.upsert({
      where: {
        bakeryBranchId_productVariantId: {
          bakeryBranchId: branch.id,
          productVariantId: variant.id,
        },
      },
      update: { availability: 'AVAILABLE', dailyCapacity: 50 },
      create: {
        tenantId: TENANT_ID,
        bakeryBranchId: branch.id,
        productVariantId: variant.id,
        priceAmount: 250_000n,
        priceCurrency: 'IRR',
        availability: 'AVAILABLE',
        dailyCapacity: 50,
        preparationMinutes: 30,
      },
    })

    // Capacity for today, or the branch cannot take an order at all.
    const serviceDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
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
      offeringId: offering.id,
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
