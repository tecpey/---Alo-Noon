import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import {
  AdminDeliveryPricingError,
  createPrismaAdminDeliveryPricingService,
  type AdminDeliveryPricingService,
} from './modules/admin-delivery-pricing'

/**
 * Publishing delivery tariffs against PostgreSQL.
 *
 * Worth exercising against the real database rather than a double, because the
 * rule that makes this hard is not in the TypeScript: three partial unique
 * indexes say only one tariff per scope may be active, and they were widened to
 * carry the vehicle so a city can hold a motorcycle rate and a car rate at
 * once. Publishing therefore has to retire the incumbent and insert the
 * successor in one transaction — do it in the wrong order, or in two
 * transactions, and Postgres refuses the insert or the city is left unable to
 * quote. No mock reproduces that.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: AdminDeliveryPricingService = createPrismaAdminDeliveryPricingService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-09-16T09:00:00.000Z')
const later = new Date('2026-09-16T11:00:00.000Z')

interface Fixture {
  tenantId: string
  cityId: string
  otherCityId: string
  zoneId: string
  otherZoneId: string
  areaId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('admin delivery pricing over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  })

  it('publishes a motorcycle and a car tariff for the same city at once', async () => {
    // The whole point of the feature, and the thing the original indexes
    // forbade: one scope, two active tariffs, one per vehicle.
    const motorcycle = await service.publishTariff(
      fixture.tenantId,
      {
        cityId: fixture.cityId,
        vehicleProfile: 'MOTORCYCLE',
        calculationMode: 'FLAT',
        baseFeeAmount: 500_000n,
        perKilometerFeeAmount: 0n,
      },
      now,
    )
    const car = await service.publishTariff(
      fixture.tenantId,
      {
        cityId: fixture.cityId,
        vehicleProfile: 'CAR',
        calculationMode: 'DISTANCE_BANDED',
        baseFeeAmount: 1_500_000n,
        perKilometerFeeAmount: 120_000n,
      },
      now,
    )

    expect(motorcycle.isActive).toBe(true)
    expect(car.isActive).toBe(true)
    // Each vehicle versions from one. Sharing a sequence would make publishing
    // a car rate silently bump the motorcycle's number.
    expect(motorcycle.version).toBe(1)
    expect(car.version).toBe(1)
  })

  it('retires the tariff it replaces, in the same breath', async () => {
    const replacement = await service.publishTariff(
      fixture.tenantId,
      {
        cityId: fixture.cityId,
        vehicleProfile: 'CAR',
        calculationMode: 'DISTANCE_BANDED',
        baseFeeAmount: 1_800_000n,
        perKilometerFeeAmount: 140_000n,
      },
      later,
    )
    expect(replacement.version).toBe(2)

    const tariffs = await service.listTariffs(fixture.tenantId, fixture.cityId)
    const cars = tariffs.filter((tariff) => tariff.vehicleProfile === 'CAR')
    // Exactly one active, and the retired one keeps its history rather than
    // being deleted: an operator checking what a fare used to be is why the
    // versions exist.
    expect(cars.filter((tariff) => tariff.isActive)).toHaveLength(1)
    expect(cars.find((tariff) => tariff.version === 1)?.isActive).toBe(false)
    expect(cars.find((tariff) => tariff.version === 1)?.effectiveUntil).toBe(later.toISOString())
    // Retiring the car rate must not touch the motorcycle's.
    expect(tariffs.find((tariff) => tariff.vehicleProfile === 'MOTORCYCLE')?.isActive).toBe(true)
  })

  it('keeps a zone tariff separate from the city-wide one', async () => {
    const zoneTariff = await service.publishTariff(
      fixture.tenantId,
      {
        cityId: fixture.cityId,
        operationalZoneId: fixture.zoneId,
        vehicleProfile: 'CAR',
        calculationMode: 'FLAT',
        baseFeeAmount: 900_000n,
        perKilometerFeeAmount: 0n,
      },
      now,
    )
    expect(zoneTariff.version).toBe(1)
    expect(zoneTariff.operationalZoneId).toBe(fixture.zoneId)

    const active = (await service.listTariffs(fixture.tenantId, fixture.cityId)).filter(
      (tariff) => tariff.isActive,
    )
    // Three at once: city motorcycle, city car, zone car.
    expect(active).toHaveLength(3)
  })

  it('refuses a zone that belongs to another city', async () => {
    // Accepted, it would publish a tariff no address in either city selects —
    // the city's own rules would never see it and the other city's zone would
    // never match. Silent, and wrong for as long as nobody checked.
    await expect(
      service.publishTariff(
        fixture.tenantId,
        {
          cityId: fixture.cityId,
          operationalZoneId: fixture.otherZoneId,
          vehicleProfile: 'CAR',
          calculationMode: 'FLAT',
          baseFeeAmount: 100_000n,
          perKilometerFeeAmount: 0n,
        },
        now,
      ),
    ).rejects.toThrow(AdminDeliveryPricingError)
  })

  it('refuses a distance tariff that charges nothing for distance', async () => {
    // A flat tariff wearing the wrong label: it would price every journey the
    // same while appearing to charge by the kilometre.
    await expect(
      service.publishTariff(
        fixture.tenantId,
        {
          cityId: fixture.otherCityId,
          vehicleProfile: 'CAR',
          calculationMode: 'DISTANCE_BANDED',
          baseFeeAmount: 500_000n,
          perKilometerFeeAmount: 0n,
        },
        now,
      ),
    ).rejects.toThrow(AdminDeliveryPricingError)
  })

  it('refuses free delivery that starts below the minimum order', async () => {
    // Unreachable: the order is refused for being under the minimum before the
    // free-delivery threshold can ever apply.
    await expect(
      service.publishTariff(
        fixture.tenantId,
        {
          cityId: fixture.otherCityId,
          vehicleProfile: 'CAR',
          calculationMode: 'FLAT',
          baseFeeAmount: 500_000n,
          perKilometerFeeAmount: 0n,
          minimumOrderAmount: 2_000_000n,
          freeDeliveryThreshold: 1_000_000n,
        },
        now,
      ),
    ).rejects.toThrow(AdminDeliveryPricingError)
  })

  it('reports which cities cannot quote a car at all', async () => {
    // The state the screen leads with. A city with no car tariff refuses every
    // factory, school and village order, and does it with a message the
    // customer cannot act on.
    const cities = await service.listCities(fixture.tenantId)
    expect(cities.find((city) => city.id === fixture.cityId)?.hasActiveCarTariff).toBe(true)
    expect(cities.find((city) => city.id === fixture.otherCityId)?.hasActiveCarTariff).toBe(false)
  })

  it('stores a city’s thresholds and reports what the quote path would use', async () => {
    const updated = await service.setCityThresholds(fixture.tenantId, fixture.cityId, {
      motorcycleItemLimit: 25,
      motorcycleRangeMetres: 7_000,
    })
    expect(updated).toMatchObject({
      motorcycleItemLimit: 25,
      motorcycleRangeMetres: 7_000,
      effectiveItemLimit: 25,
      effectiveRangeMetres: 7_000,
    })
  })

  it('clears a threshold back to the documented default', async () => {
    // Null is a real answer — "nobody has measured this city" — and is
    // deliberately distinguishable from a tenant choosing a number that happens
    // to equal the default.
    const cleared = await service.setCityThresholds(fixture.tenantId, fixture.cityId, {
      motorcycleItemLimit: null,
      motorcycleRangeMetres: null,
    })
    expect(cleared.motorcycleItemLimit).toBeNull()
    expect(cleared.effectiveItemLimit).toBe(40)
    expect(cleared.effectiveRangeMetres).toBe(12_000)
  })

  it('refuses a threshold of zero, which would strand the whole city', async () => {
    await expect(
      service.setCityThresholds(fixture.tenantId, fixture.cityId, {
        motorcycleItemLimit: 0,
        motorcycleRangeMetres: 5_000,
      }),
    ).rejects.toThrow(AdminDeliveryPricingError)
  })

  it('turns motorcycles off for one area without touching the rest', async () => {
    // The villages switch: independent of distance, because a village eight
    // kilometres out across a river is inside the range and still nowhere to
    // send a loaded motorcycle.
    const off = await service.setAreaMotorcycleAllowed(fixture.tenantId, fixture.areaId, false)
    expect(off.motorcycleAllowed).toBe(false)

    const cities = await service.listCities(fixture.tenantId)
    const area = cities
      .flatMap((city) => city.areas)
      .find((candidate) => candidate.id === fixture.areaId)
    expect(area?.motorcycleAllowed).toBe(false)

    const back = await service.setAreaMotorcycleAllowed(fixture.tenantId, fixture.areaId, true)
    expect(back.motorcycleAllowed).toBe(true)
  })

  it('refuses a city or area belonging to nobody', async () => {
    await expect(
      service.setCityThresholds(fixture.tenantId, randomUUID(), {
        motorcycleItemLimit: 10,
        motorcycleRangeMetres: 1_000,
      }),
    ).rejects.toThrow(AdminDeliveryPricingError)
    await expect(
      service.setAreaMotorcycleAllowed(fixture.tenantId, randomUUID(), false),
    ).rejects.toThrow(AdminDeliveryPricingError)
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `delivery-${suffix.toLowerCase()}`, name: `Delivery ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `DLV-${suffix}`, nameFa: 'بابل', isActive: true },
  })
  const otherCity = await prisma.city.create({
    data: { tenantId, code: `DLV2-${suffix}`, nameFa: 'آمل', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `DZ-${suffix}`, nameFa: 'مرکز', isActive: true },
  })
  const otherZone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: otherCity.id,
      code: `DZ2-${suffix}`,
      nameFa: 'ناحیهٔ آمل',
      isActive: true,
    },
  })
  const area = await prisma.serviceArea.create({
    data: {
      tenantId,
      operationalZoneId: zone.id,
      code: `DA-${suffix}`,
      nameFa: 'روستای گنج‌افروز',
      // A square around Babol. Never matched here — the geometry matters to
      // address creation, and this suite is about the settings around it.
      boundaryGeoJson: {
        type: 'Polygon',
        coordinates: [
          [
            [52.6, 36.5],
            [52.8, 36.5],
            [52.8, 36.6],
            [52.6, 36.6],
            [52.6, 36.5],
          ],
        ],
      },
      isActive: true,
    },
  })

  return {
    tenantId,
    cityId: city.id,
    otherCityId: otherCity.id,
    zoneId: zone.id,
    otherZoneId: otherZone.id,
    areaId: area.id,
  }
}
