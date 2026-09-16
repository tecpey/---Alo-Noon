import type { Prisma, PrismaClient } from '@alo-noon/database'
import { DEFAULT_VEHICLE_POLICY } from '@alo-noon/domain'

/**
 * The three settings that decide what a delivery costs and what carries it.
 *
 * All three existed as columns before they existed as a screen, which meant the
 * only way to publish a car rate was to write SQL against production — and
 * until one was published, the first order from a factory or a village was
 * refused. This is the screen.
 *
 * They are governed together because an operator setting one is almost always
 * about to set another: raising a city's motorcycle range and publishing the
 * car tariff that catches what falls outside it are two halves of one decision.
 */

export type VehicleProfile = 'MOTORCYCLE' | 'CAR'
export type PricingMode = 'FLAT' | 'DISTANCE_BANDED'

export interface AdminDeliveryTariff {
  id: string
  cityId: string
  cityNameFa: string
  operationalZoneId: string | null
  operationalZoneNameFa: string | null
  vehicleProfile: VehicleProfile
  version: number
  calculationMode: PricingMode
  baseFeeAmount: string
  perKilometerFeeAmount: string
  minimumOrderAmount: string | null
  freeDeliveryThreshold: string | null
  effectiveFrom: string
  effectiveUntil: string | null
  isActive: boolean
}

export interface AdminDeliveryArea {
  id: string
  nameFa: string
  code: string
  operationalZoneId: string
  operationalZoneNameFa: string
  motorcycleAllowed: boolean
  isActive: boolean
}

export interface AdminDeliveryCity {
  id: string
  nameFa: string
  /** Null where the city has never been measured; the effective value follows. */
  motorcycleItemLimit: number | null
  motorcycleRangeMetres: number | null
  /** What the quote path would actually use today, defaults included. */
  effectiveItemLimit: number
  effectiveRangeMetres: number
  areas: AdminDeliveryArea[]
  /**
   * Whether a car can be quoted at all in this city.
   *
   * Surfaced next to the thresholds because the two are read together: a city
   * whose range is tight will produce car orders, and a city with no car
   * tariff refuses every one of them. An operator should see that pairing
   * before a customer does.
   */
  hasActiveCarTariff: boolean
}

export interface PublishTariffInput {
  cityId: string
  operationalZoneId?: string
  vehicleProfile: VehicleProfile
  calculationMode: PricingMode
  baseFeeAmount: bigint
  perKilometerFeeAmount: bigint
  minimumOrderAmount?: bigint
  freeDeliveryThreshold?: bigint
}

export class AdminDeliveryPricingError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(code)
  }
}

export interface AdminDeliveryPricingService {
  listCities(tenantId: string): Promise<AdminDeliveryCity[]>
  listTariffs(tenantId: string, cityId?: string): Promise<AdminDeliveryTariff[]>
  publishTariff(
    tenantId: string,
    input: PublishTariffInput,
    now: Date,
  ): Promise<AdminDeliveryTariff>
  setCityThresholds(
    tenantId: string,
    cityId: string,
    thresholds: { motorcycleItemLimit: number | null; motorcycleRangeMetres: number | null },
  ): Promise<AdminDeliveryCity>
  setAreaMotorcycleAllowed(
    tenantId: string,
    areaId: string,
    allowed: boolean,
  ): Promise<AdminDeliveryArea>
}

export function createPrismaAdminDeliveryPricingService(
  prisma: PrismaClient,
): AdminDeliveryPricingService {
  return {
    async listCities(tenantId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const [cities, carTariffs] = await Promise.all([
          transaction.city.findMany({
            where: { tenantId },
            orderBy: { nameFa: 'asc' },
            select: {
              id: true,
              nameFa: true,
              motorcycleItemLimit: true,
              motorcycleRangeMetres: true,
              operationalZones: {
                orderBy: { nameFa: 'asc' },
                select: {
                  id: true,
                  nameFa: true,
                  serviceAreas: {
                    orderBy: { nameFa: 'asc' },
                    select: {
                      id: true,
                      nameFa: true,
                      code: true,
                      motorcycleAllowed: true,
                      isActive: true,
                    },
                  },
                },
              },
            },
          }),
          transaction.deliveryPricingRule.findMany({
            where: { tenantId, vehicleProfile: 'CAR', isActive: true },
            select: { cityId: true },
          }),
        ])
        const withCar = new Set(carTariffs.map((rule) => rule.cityId))
        return cities.map((city) => ({
          id: city.id,
          nameFa: city.nameFa,
          motorcycleItemLimit: city.motorcycleItemLimit,
          motorcycleRangeMetres: city.motorcycleRangeMetres,
          effectiveItemLimit:
            city.motorcycleItemLimit ?? DEFAULT_VEHICLE_POLICY.motorcycleItemLimit,
          effectiveRangeMetres:
            city.motorcycleRangeMetres ?? DEFAULT_VEHICLE_POLICY.motorcycleRangeMetres,
          hasActiveCarTariff: withCar.has(city.id),
          areas: city.operationalZones.flatMap((zone) =>
            zone.serviceAreas.map((area) => ({
              id: area.id,
              nameFa: area.nameFa,
              code: area.code,
              operationalZoneId: zone.id,
              operationalZoneNameFa: zone.nameFa,
              motorcycleAllowed: area.motorcycleAllowed,
              isActive: area.isActive,
            })),
          ),
        }))
      })
    },

    async listTariffs(tenantId, cityId) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const rules = await transaction.deliveryPricingRule.findMany({
          where: { tenantId, ...(cityId && { cityId }) },
          orderBy: [
            { cityId: 'asc' },
            { operationalZoneId: 'asc' },
            { vehicleProfile: 'asc' },
            { version: 'desc' },
          ],
          include: {
            city: { select: { nameFa: true } },
            operationalZone: { select: { nameFa: true } },
          },
        })
        return rules.map(toTariff)
      })
    },

    /**
     * Publishes a new version and retires the one it replaces, in one
     * transaction.
     *
     * Two rules for the same scope and vehicle cannot both be active — a
     * partial unique index says so — so this is not merely tidy: inserting
     * without deactivating the incumbent fails, and deactivating without
     * inserting leaves the city unable to quote. Doing them apart would leave
     * whichever half succeeded.
     *
     * Serializable because the version number is read and then written. Two
     * operators publishing at once would otherwise both read version 3 and
     * both try to write version 4.
     */
    async publishTariff(tenantId, input, now) {
      return prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`

          const city = await transaction.city.findFirst({
            where: { id: input.cityId, tenantId },
            select: { id: true },
          })
          if (!city) throw new AdminDeliveryPricingError('CITY_NOT_FOUND', 404)

          if (input.operationalZoneId) {
            const zone = await transaction.operationalZone.findFirst({
              where: { id: input.operationalZoneId, tenantId, cityId: input.cityId },
              select: { id: true },
            })
            // Checked rather than trusted: a zone from another city would
            // publish a tariff that no address in either city ever selects.
            if (!zone) throw new AdminDeliveryPricingError('ZONE_NOT_IN_CITY', 422)
          }

          if (input.calculationMode === 'DISTANCE_BANDED' && input.perKilometerFeeAmount <= 0n) {
            // A distance tariff at zero per kilometre is a flat tariff wearing
            // the wrong label, and it would price every journey the same while
            // appearing to charge for distance.
            throw new AdminDeliveryPricingError('DISTANCE_TARIFF_NEEDS_RATE', 422)
          }
          if (
            input.freeDeliveryThreshold !== undefined &&
            input.minimumOrderAmount !== undefined &&
            input.freeDeliveryThreshold < input.minimumOrderAmount
          ) {
            // Free delivery below the minimum order can never be reached: the
            // order is refused before the threshold applies.
            throw new AdminDeliveryPricingError('FREE_THRESHOLD_BELOW_MINIMUM', 422)
          }

          const scope = {
            tenantId,
            cityId: input.cityId,
            operationalZoneId: input.operationalZoneId ?? null,
            vehicleProfile: input.vehicleProfile,
          }
          const latest = await transaction.deliveryPricingRule.findFirst({
            where: scope,
            orderBy: { version: 'desc' },
            select: { id: true, version: true, isActive: true },
          })
          if (latest?.isActive) {
            await transaction.deliveryPricingRule.update({
              where: { id: latest.id },
              data: { isActive: false, effectiveUntil: now },
            })
          }

          const created = await transaction.deliveryPricingRule.create({
            data: {
              ...scope,
              version: (latest?.version ?? 0) + 1,
              calculationMode: input.calculationMode,
              baseFeeAmount: input.baseFeeAmount,
              perKilometerFeeAmount: input.perKilometerFeeAmount,
              ...(input.minimumOrderAmount !== undefined && {
                minimumOrderAmount: input.minimumOrderAmount,
              }),
              ...(input.freeDeliveryThreshold !== undefined && {
                freeDeliveryThreshold: input.freeDeliveryThreshold,
              }),
              effectiveFrom: now,
              isActive: true,
            },
            include: {
              city: { select: { nameFa: true } },
              operationalZone: { select: { nameFa: true } },
            },
          })
          return toTariff(created)
        },
        { isolationLevel: 'Serializable' },
      )
    },

    async setCityThresholds(tenantId, cityId, thresholds) {
      // Null is a legitimate value — it means "no measurement, use the
      // documented default" — so it is written rather than treated as absent.
      if (
        (thresholds.motorcycleItemLimit !== null && thresholds.motorcycleItemLimit < 1) ||
        (thresholds.motorcycleRangeMetres !== null && thresholds.motorcycleRangeMetres < 1)
      ) {
        throw new AdminDeliveryPricingError('THRESHOLD_NOT_POSITIVE', 422)
      }
      await withTenant(prisma, tenantId, async (transaction) => {
        const existing = await transaction.city.findFirst({
          where: { id: cityId, tenantId },
          select: { id: true },
        })
        if (!existing) throw new AdminDeliveryPricingError('CITY_NOT_FOUND', 404)
        await transaction.city.update({
          where: { id: cityId },
          data: {
            motorcycleItemLimit: thresholds.motorcycleItemLimit,
            motorcycleRangeMetres: thresholds.motorcycleRangeMetres,
          },
        })
      })
      const cities = await this.listCities(tenantId)
      const updated = cities.find((city) => city.id === cityId)
      if (!updated) throw new AdminDeliveryPricingError('CITY_NOT_FOUND', 404)
      return updated
    },

    async setAreaMotorcycleAllowed(tenantId, areaId, allowed) {
      return withTenant(prisma, tenantId, async (transaction) => {
        const area = await transaction.serviceArea.findFirst({
          where: { id: areaId, tenantId },
          select: { id: true },
        })
        if (!area) throw new AdminDeliveryPricingError('AREA_NOT_FOUND', 404)
        const updated = await transaction.serviceArea.update({
          where: { id: areaId },
          data: { motorcycleAllowed: allowed },
          include: { operationalZone: { select: { id: true, nameFa: true } } },
        })
        return {
          id: updated.id,
          nameFa: updated.nameFa,
          code: updated.code,
          operationalZoneId: updated.operationalZone.id,
          operationalZoneNameFa: updated.operationalZone.nameFa,
          motorcycleAllowed: updated.motorcycleAllowed,
          isActive: updated.isActive,
        }
      })
    },
  }
}

function toTariff(rule: {
  id: string
  cityId: string
  city: { nameFa: string }
  operationalZoneId: string | null
  operationalZone: { nameFa: string } | null
  vehicleProfile: string
  version: number
  calculationMode: string
  baseFeeAmount: bigint
  perKilometerFeeAmount: bigint
  minimumOrderAmount: bigint | null
  freeDeliveryThreshold: bigint | null
  effectiveFrom: Date
  effectiveUntil: Date | null
  isActive: boolean
}): AdminDeliveryTariff {
  return {
    id: rule.id,
    cityId: rule.cityId,
    cityNameFa: rule.city.nameFa,
    operationalZoneId: rule.operationalZoneId,
    operationalZoneNameFa: rule.operationalZone?.nameFa ?? null,
    vehicleProfile: rule.vehicleProfile as VehicleProfile,
    version: rule.version,
    calculationMode: rule.calculationMode as PricingMode,
    // Money crosses as a string. Rial amounts exceed what a JSON number holds
    // exactly, and a fare that rounds in transit is a fare nobody can reconcile.
    baseFeeAmount: rule.baseFeeAmount.toString(),
    perKilometerFeeAmount: rule.perKilometerFeeAmount.toString(),
    minimumOrderAmount: rule.minimumOrderAmount?.toString() ?? null,
    freeDeliveryThreshold: rule.freeDeliveryThreshold?.toString() ?? null,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    effectiveUntil: rule.effectiveUntil?.toISOString() ?? null,
    isActive: rule.isActive,
  }
}

async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return operation(transaction)
  })
}
