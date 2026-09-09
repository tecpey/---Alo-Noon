import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import {
  claimDeliveryWindow,
  listDeliveryWindows,
  releaseDeliveryWindow,
  resolveDeliveryWindow,
} from './modules/delivery-windows'

/**
 * Exercises scheduled delivery windows against PostgreSQL.
 *
 * The interesting rules here are the ones that only hold when several rows and
 * several transactions agree: two customers racing the last place in the seven
 * o'clock batch cannot both win, a window materialises exactly once however
 * many people ask for it at the same moment, and a window nobody offered cannot
 * be booked by naming it.
 *
 * The database's own guards are exercised too. They are the last line if the
 * service is ever wrong, and a check constraint nobody has seen fire is a check
 * constraint nobody knows works.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()

/** Tuesday 2026-06-02, 03:00 UTC — half past six in the morning in Tehran. */
const now = new Date('2026-06-02T03:00:00.000Z')

interface Fixture {
  tenantId: string
  branchId: string
  unscheduledBranchId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

async function withTenant<T>(
  tenantId: string,
  run: (t: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return run(transaction)
  })
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `win-${suffix.toLowerCase()}`, name: `Windows ${suffix}`, status: 'ACTIVE' },
  })
  return withTenant(tenant.id, async (t) => {
    const city = await t.city.create({
      data: { tenantId: tenant.id, code: `WIN${suffix}`, nameFa: 'شهر', isActive: true },
    })
    const zone = await t.operationalZone.create({
      data: {
        tenantId: tenant.id,
        cityId: city.id,
        code: `WZ${suffix}`.slice(0, 16),
        nameFa: 'ناحیه',
        isActive: true,
      },
    })
    const bakery = await t.bakery.create({
      data: {
        tenantId: tenant.id,
        legalName: `Bakery ${suffix}`,
        displayNameFa: 'نانوایی',
        partnerStatus: 'ACTIVE',
      },
    })
    const makeBranch = async (code: string, maxOrders: number) =>
      t.bakeryBranch.create({
        data: {
          tenantId: tenant.id,
          bakeryId: bakery.id,
          cityId: city.id,
          operationalZoneId: zone.id,
          code: `${code}${suffix}`.slice(0, 16),
          nameFa: 'شعبه',
          addressLine: 'نشانی',
          latitude: '36.5513',
          longitude: '52.6790',
          operationalStatus: 'ACTIVE',
          qualityStatus: 'APPROVED',
          deliveryWindowMinutes: 120,
          deliveryLeadTimeMinutes: 90,
          deliveryWindowHorizonDays: 1,
          deliveryWindowMaxOrders: maxOrders,
        },
      })

    const branch = await makeBranch('WB', 1)
    // Open every day, six in the morning until eight at night.
    await t.bakeryOperatingHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        tenantId: tenant.id,
        bakeryBranchId: branch.id,
        dayOfWeek,
        opensAtMinute: 6 * 60,
        closesAtMinute: 20 * 60,
        isClosed: false,
      })),
    })

    // A branch that never recorded its hours. It must offer nothing rather than
    // everything — the alternative is a bakery nobody configured quietly
    // promising deliveries at four in the morning.
    const unscheduled = await makeBranch('WU', 5)

    return {
      tenantId: tenant.id,
      branchId: branch.id,
      unscheduledBranchId: unscheduled.id,
    }
  })
}

databaseDescribe('delivery windows against PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
  })

  it('offers the rest of today and all of tomorrow, in the city timezone', async () => {
    const windows = await withTenant(fixture.tenantId, (t) =>
      listDeliveryWindows(t, fixture.tenantId, fixture.branchId, now),
    )

    // 06:30 local plus 90 minutes of lead time: today starts at 08:00 local,
    // which is 04:30 UTC.
    expect(windows[0]?.startsAt.toISOString()).toBe('2026-06-02T04:30:00.000Z')
    expect(windows[0]?.serviceDate).toBe('2026-06-02')
    expect(windows[0]?.endsAt.toISOString()).toBe('2026-06-02T06:30:00.000Z')
    // Six left today (08:00 through 20:00) and seven tomorrow.
    expect(windows).toHaveLength(13)
    expect(windows.at(-1)?.serviceDate).toBe('2026-06-03')
    // Nothing has been booked, so every window is empty and none of them exist
    // as rows yet.
    expect(windows.every((window) => window.available && window.remaining === 1)).toBe(true)
    const materialised = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.count({ where: { bakeryBranchId: fixture.branchId } }),
    )
    expect(materialised).toBe(0)
  })

  it('offers nothing for a branch that never recorded its hours', async () => {
    const windows = await withTenant(fixture.tenantId, (t) =>
      listDeliveryWindows(t, fixture.tenantId, fixture.unscheduledBranchId, now),
    )
    expect(windows).toEqual([])
  })

  it('materialises a window the first time somebody wants it', async () => {
    const startsAt = new Date('2026-06-02T04:30:00.000Z')
    const resolved = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )
    expect(resolved).not.toBeNull()
    expect(resolved?.endsAt.toISOString()).toBe('2026-06-02T06:30:00.000Z')
    expect(resolved?.serviceDate).toBe('2026-06-02')

    const row = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.findFirst({ where: { id: resolved!.id } }),
    )
    expect(row?.maxOrders).toBe(1)
    expect(row?.reservedOrders).toBe(0)
    expect(row?.serviceDate.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })

  /**
   * Two customers asking for seven o'clock at the same moment both arrive with
   * nothing in the table. Exactly one of them may create the row.
   */
  it('materialises the same window once however many people ask', async () => {
    const startsAt = new Date('2026-06-02T06:30:00.000Z')
    const resolutions = await Promise.all([
      withTenant(fixture.tenantId, (t) =>
        resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
      ),
      withTenant(fixture.tenantId, (t) =>
        resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
      ),
    ])
    expect(resolutions[0]?.id).toBe(resolutions[1]?.id)
    const count = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.count({ where: { bakeryBranchId: fixture.branchId, startsAt } }),
    )
    expect(count).toBe(1)
  })

  /**
   * The start arrives from a browser, so it is a claim rather than a fact.
   * Without re-deriving the offer, an order could be accepted for three in the
   * morning or for a date past the horizon the bakery agreed to plan for.
   */
  it('refuses a window nobody offered', async () => {
    const middleOfTheNight = new Date('2026-06-02T23:30:00.000Z')
    const pastTheHorizon = new Date('2026-06-09T04:30:00.000Z')
    const offGrid = new Date('2026-06-02T04:31:00.000Z')
    const alreadyTooSoon = new Date('2026-06-02T02:30:00.000Z')

    for (const startsAt of [middleOfTheNight, pastTheHorizon, offGrid, alreadyTooSoon]) {
      const resolved = await withTenant(fixture.tenantId, (t) =>
        resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
      )
      expect(resolved, startsAt.toISOString()).toBeNull()
    }
  })

  it('holds a place, and reports the window as full once it is taken', async () => {
    const startsAt = new Date('2026-06-02T08:30:00.000Z')
    const window = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )
    expect(window).not.toBeNull()

    const claimed = await withTenant(fixture.tenantId, (t) =>
      claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )
    expect(claimed).toBe(true)

    const listed = await withTenant(fixture.tenantId, (t) =>
      listDeliveryWindows(t, fixture.tenantId, fixture.branchId, now),
    )
    const taken = listed.find((entry) => entry.startsAt.getTime() === startsAt.getTime())
    expect(taken?.remaining).toBe(0)
    expect(taken?.available).toBe(false)
  })

  /**
   * The reason the claim is a conditional update rather than a read-then-write.
   * The read that says a window has room is stale the moment it returns.
   */
  it('lets only one of two racing customers take the last place', async () => {
    const startsAt = new Date('2026-06-02T10:30:00.000Z')
    const window = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )

    const outcomes = await Promise.all([
      withTenant(fixture.tenantId, (t) =>
        claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
      ),
      withTenant(fixture.tenantId, (t) =>
        claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
      ),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)

    const row = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.findFirst({ where: { id: window!.id } }),
    )
    expect(row?.reservedOrders).toBe(1)
  })

  it('gives the place back when the order that held it is cancelled', async () => {
    const startsAt = new Date('2026-06-02T12:30:00.000Z')
    const window = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )
    await withTenant(fixture.tenantId, (t) =>
      claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )
    await withTenant(fixture.tenantId, (t) =>
      releaseDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )

    const row = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.findFirst({ where: { id: window!.id } }),
    )
    expect(row?.reservedOrders).toBe(0)

    const reclaimed = await withTenant(fixture.tenantId, (t) =>
      claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )
    expect(reclaimed).toBe(true)
  })

  /** A release can never drive the counter below zero and hand out capacity. */
  it('will not release a window below empty', async () => {
    const startsAt = new Date('2026-06-02T14:30:00.000Z')
    const window = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )
    await withTenant(fixture.tenantId, (t) =>
      releaseDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )
    const row = await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.findFirst({ where: { id: window!.id } }),
    )
    expect(row?.reservedOrders).toBe(0)
  })

  it('refuses a claim on a window an operator suspended', async () => {
    // Tomorrow at six in the morning. Today is spent: the branch shuts at eight
    // in the evening, so the last window it can offer today starts at six.
    const startsAt = new Date('2026-06-03T02:30:00.000Z')
    const window = await withTenant(fixture.tenantId, (t) =>
      resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
    )
    await withTenant(fixture.tenantId, (t) =>
      t.bakeryDeliveryWindow.update({ where: { id: window!.id }, data: { suspended: true } }),
    )
    const claimed = await withTenant(fixture.tenantId, (t) =>
      claimDeliveryWindow(t, fixture.tenantId, window!.id, now),
    )
    expect(claimed).toBe(false)

    const listed = await withTenant(fixture.tenantId, (t) =>
      listDeliveryWindows(t, fixture.tenantId, fixture.branchId, now),
    )
    expect(listed.find((entry) => entry.startsAt.getTime() === startsAt.getTime())?.available).toBe(
      false,
    )
  })

  describe('the guards the database keeps of its own', () => {
    it('refuses a window that has taken more orders than it holds', async () => {
      const startsAt = new Date('2026-06-03T04:30:00.000Z')
      const window = await withTenant(fixture.tenantId, (t) =>
        resolveDeliveryWindow(t, fixture.tenantId, fixture.branchId, startsAt, now),
      )
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.bakeryDeliveryWindow.update({
            where: { id: window!.id },
            data: { reservedOrders: 99 },
          }),
        ),
      ).rejects.toThrow(/delivery_window_capacity_check/)
    })

    it('refuses a window that ends before it starts', async () => {
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.bakeryDeliveryWindow.create({
            data: {
              tenantId: fixture.tenantId,
              bakeryBranchId: fixture.branchId,
              serviceDate: new Date('2026-06-05T00:00:00.000Z'),
              startsAt: new Date('2026-06-05T08:00:00.000Z'),
              endsAt: new Date('2026-06-05T06:00:00.000Z'),
              maxOrders: 4,
            },
          }),
        ),
      ).rejects.toThrow(/delivery_window_span_check/)
    })

    it('refuses a branch policy that could never produce a window', async () => {
      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.bakeryBranch.update({
            where: { id: fixture.branchId },
            data: { deliveryWindowMinutes: 0 },
          }),
        ),
      ).rejects.toThrow(/branch_delivery_window_policy_check/)
    })
  })
})
