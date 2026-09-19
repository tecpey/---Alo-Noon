/**
 * What the same basket costs to deliver at different hours of the same day.
 *
 * The published tariff is one number; this is what a customer is actually
 * quoted once the moment is taken into account. Run it after changing the fare
 * policy, and read the two columns against each other.
 */
import { PrismaClient } from '@alo-noon/database'
import {
  BABOL_PILOT_COVERAGE,
  calculateDeliveryFee,
  deliveryVehicleOptions,
  estimateRouteDistance,
  selectDeliveryPricingRule,
  vehiclePolicyForCity,
} from '@alo-noon/domain'

import {
  createEnvironmentDeliveryFareCredentialResolver,
  createPrismaDeliveryFareService,
} from '../src/modules/delivery-fare.js'
import { createDeliveryFareRegistry } from '@alo-noon/domain'

const prisma = new PrismaClient()
const TENANT_ID = process.env['LAUNCH_TENANT_ID'] ?? '00000000-0000-4000-8000-000000000001'
const BRANCH_CODE = process.env['LAUNCH_BRANCH_CODE'] ?? 'BABOL-1'
const SUBTOTAL = BigInt(process.env['PREVIEW_SUBTOTAL_RIAL'] ?? '500000')
const ITEM_COUNT = Number(process.env['PREVIEW_ITEM_COUNT'] ?? '5')

const toman = (rial: bigint) => `${(rial / 10n).toLocaleString('en-US')}`

const fareService = createPrismaDeliveryFareService(prisma, {
  registry: createDeliveryFareRegistry([]),
  credentialResolver: createEnvironmentDeliveryFareCredentialResolver(process.env),
  environment: 'TEST',
})

// Three moments of one Tehran day: the breakfast rush, an ordinary afternoon,
// and the evening rush. Expressed in UTC because that is what a Date holds.
const MOMENTS = [
  { labelFa: 'ساعت ۷ صبح', at: new Date('2026-09-20T03:30:00.000Z') },
  { labelFa: 'ساعت ۲ بعدازظهر', at: new Date('2026-09-20T10:30:00.000Z') },
  { labelFa: 'ساعت ۶ عصر', at: new Date('2026-09-20T14:30:00.000Z') },
]

const context = await prisma.$transaction(
  async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`
    const branch = await tx.bakeryBranch.findFirstOrThrow({
      where: { tenantId: TENANT_ID, code: BRANCH_CODE },
      select: { latitude: true, longitude: true, cityId: true, operationalZoneId: true },
    })
    const city = await tx.city.findFirstOrThrow({
      where: { id: branch.cityId },
      select: { motorcycleItemLimit: true, motorcycleRangeMetres: true, timezone: true },
    })
    const rules = await tx.deliveryPricingRule.findMany({
      where: { tenantId: TENANT_ID, cityId: branch.cityId, isActive: true },
    })
    return { branch, city, rules }
  },
  { timeout: 30_000 },
)

const candidates = context.rules.map((rule) => ({
  id: rule.id,
  operationalZoneId: rule.operationalZoneId,
  vehicleProfile: rule.vehicleProfile,
  version: rule.version,
  mode: rule.calculationMode,
  baseFeeAmount: rule.baseFeeAmount,
  perKmFeeAmount: rule.perKilometerFeeAmount,
  minimumOrderAmount: rule.minimumOrderAmount,
  freeDeliveryThresholdAmount: rule.freeDeliveryThreshold,
  currency: rule.currency,
}))
const origin = {
  latitude: Number(context.branch.latitude),
  longitude: Number(context.branch.longitude),
}
const policy = vehiclePolicyForCity(context.city)

console.log(`branch ${BRANCH_CODE} — ${ITEM_COUNT} items, ${toman(SUBTOTAL)} تومان\n`)
console.log(
  `${'منطقه'.padEnd(21)} ${'وسیله'.padEnd(11)} ${MOMENTS.map((m) => m.labelFa.padStart(15)).join('')}`,
)

for (const area of BABOL_PILOT_COVERAGE) {
  const distance = estimateRouteDistance(
    origin,
    { latitude: area.latitude, longitude: area.longitude },
    'ROUTING_NOT_CONFIGURED',
  ).distanceMetres
  const choice = deliveryVehicleOptions(
    {
      itemCount: ITEM_COUNT,
      distanceMetres: distance,
      motorcycleAllowedInArea: area.motorcycleAllowed,
    },
    policy,
  )
  const cells: string[] = []
  for (const moment of MOMENTS) {
    try {
      const rule = selectDeliveryPricingRule(
        candidates,
        context.branch.operationalZoneId,
        choice.fallback,
      )
      const tariff = calculateDeliveryFee(rule, SUBTOTAL, distance).deliveryFeeAmount
      const fare = await fareService.ownFare(
        TENANT_ID,
        { tariffAmount: tariff, timeZone: context.city.timezone },
        moment.at,
      )
      const mark = fare.reasonCodes.length > 0 ? '*' : ' '
      cells.push(`${toman(fare.amount)}${mark}`.padStart(15))
    } catch (error) {
      cells.push((error instanceof Error ? error.message : 'error').slice(0, 14).padStart(15))
    }
  }
  console.log(`${area.nameFa.padEnd(21)} ${choice.fallback.padEnd(11)} ${cells.join('')}`)
}

console.log('\n* = این لحظه نرخ را بالا برده است. همهٔ مبلغ‌ها تومان.')
await prisma.$disconnect()
