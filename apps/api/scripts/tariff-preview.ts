/**
 * What every covered town would be charged for delivery, before a customer
 * finds out.
 *
 * Publishing a tariff is two numbers and a mode, and the thing an operator
 * actually wants to know is what those two numbers do to the far end of the
 * map. A rate that looks modest per kilometre is a fare nobody accepts at
 * thirty-five kilometres, and the only way that was visible before was to place
 * an order to Amol.
 *
 * It computes the same way the quote path does, from the same rows: the
 * published tariffs for the branch's city and zone, the city's vehicle policy,
 * the coverage table's town centres, and the branch's own position. What it
 * does not do is call the routing engine — distances here are the straight line
 * scaled by the detour factor, which is what an unrouted deployment quotes
 * anyway, and an underestimate once Neshan is live and following real roads.
 *
 * Run after `publish-tariff`, and read the last column.
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

const prisma = new PrismaClient()
const TENANT_ID = process.env['LAUNCH_TENANT_ID'] ?? '00000000-0000-4000-8000-000000000001'
/** Which bakery the bread leaves from; every distance below is measured from it. */
const BRANCH_CODE = process.env['LAUNCH_BRANCH_CODE'] ?? 'BABOL-1'
/** A basket worth pricing against, in Rial. Matters only for the free-delivery
    threshold and the minimum order, both of which are compared to a subtotal. */
const SUBTOTAL_RIAL = BigInt(process.env['PREVIEW_SUBTOTAL_RIAL'] ?? '500000')
const ITEM_COUNT = Number(process.env['PREVIEW_ITEM_COUNT'] ?? '5')
const now = new Date()

const toman = (rial: bigint) => `${(rial / 10n).toLocaleString('en-US')} تومان`

await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`

  const branch = await tx.bakeryBranch.findFirstOrThrow({
    where: { tenantId: TENANT_ID, code: BRANCH_CODE },
    select: { latitude: true, longitude: true, cityId: true, operationalZoneId: true },
  })
  const city = await tx.city.findFirstOrThrow({
    where: { id: branch.cityId },
    select: { motorcycleItemLimit: true, motorcycleRangeMetres: true },
  })
  const policy = vehiclePolicyForCity(city)
  const rules = await tx.deliveryPricingRule.findMany({
    where: {
      tenantId: TENANT_ID,
      cityId: branch.cityId,
      isActive: true,
      effectiveFrom: { lte: now },
      AND: [
        { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] },
        { OR: [{ operationalZoneId: branch.operationalZoneId }, { operationalZoneId: null }] },
      ],
    },
  })
  const candidates = rules.map((rule) => ({
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

  const origin = { latitude: Number(branch.latitude), longitude: Number(branch.longitude) }

  console.log(`branch  ${BRANCH_CODE}`)
  console.log(
    `policy  motorcycle up to ${policy.motorcycleItemLimit} items and ` +
      `${policy.motorcycleRangeMetres / 1000}km`,
  )
  console.log(`basket  ${ITEM_COUNT} items, ${toman(SUBTOTAL_RIAL)}\n`)
  console.log('منطقه                 فاصله   وسیله        کرایه')
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
    // Reported rather than thrown. The whole point of this script is to be run
    // by somebody whose tariffs are incomplete, and a stack trace on the first
    // uncovered town hides the other seven.
    let outcome: string
    try {
      const rule = selectDeliveryPricingRule(candidates, branch.operationalZoneId, choice.fallback)
      outcome = toman(calculateDeliveryFee(rule, SUBTOTAL_RIAL, distance).deliveryFeeAmount)
    } catch (error) {
      outcome = `— ${error instanceof Error ? error.message : String(error)}`
    }
    console.log(
      `${area.nameFa.padEnd(21)} ${String(Math.round(distance / 100) / 10).padStart(5)}km  ` +
        `${choice.fallback.padEnd(12)} ${outcome}`,
    )
  }
  console.log(
    '\nDistances are the straight line scaled by the detour factor, which is what\n' +
      'an unrouted deployment quotes. With a routing engine live they grow.\n',
  )
})

await prisma.$disconnect()
