import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaDeliveryTripService } from './modules/delivery-trips'

/**
 * Batching over a real database.
 *
 * The planner's arithmetic is covered in the domain; what is only observable
 * here is whether a run can be claimed twice, whether a dispatched run can still
 * be reshaped, and whether offering a run of three orders leaves three orders
 * offered or one. Those are the failures that would reach a customer as bread
 * that never arrives, and none of them are visible without Postgres.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const NOW = new Date('2026-08-26T09:00:00.000Z')

afterAll(async () => prisma.$disconnect())

databaseDescribe('delivery trips over PostgreSQL', () => {
  it('proposes a run around one order without writing anything', async () => {
    const world = await buildWorld('PROPOSE')
    const anchor = await world.delivery(300)
    await world.delivery(360)

    const proposal = await world.service.proposeTrip(world.tenantId, { anchorTaskId: anchor }, NOW)

    expect(proposal.stops.map((stop) => stop.taskId)).toContain(anchor)
    expect(proposal.stops).toHaveLength(2)
    expect(proposal.savedMetres).toBeGreaterThan(0)
    // A proposal a dispatcher may decline leaves nothing behind to decline.
    expect(await prisma.deliveryTrip.count({ where: { tenantId: world.tenantId } })).toBe(0)
  })

  it('claims each delivery so a second run cannot take it', async () => {
    const world = await buildWorld('CLAIM')
    const first = await world.delivery(300)
    const second = await world.delivery(360)

    await world.create([first, second])

    // The unique index is what makes double-dispatch impossible rather than
    // merely unlikely: two dispatchers planning at once cannot both claim the
    // same loaf.
    await expect(world.create([second])).rejects.toMatchObject({
      code: 'DELIVERY_ALREADY_ON_A_TRIP',
    })
  })

  it('keeps a dispatcher’s chosen sequence rather than improving it', async () => {
    const world = await buildWorld('SEQUENCE')
    const far = await world.delivery(900)
    const near = await world.delivery(200)

    const trip = await world.create([far, near])

    // Silently re-ordering would mean the run a dispatcher saw is not the run
    // that happens.
    expect(trip.stops.map((stop) => stop.taskId)).toEqual([far, near])
    expect(trip.stops.map((stop) => stop.sequence)).toEqual([1, 2])
  })

  it('offers every drop on the run, or none', async () => {
    const world = await buildWorld('DISPATCH')
    const first = await world.delivery(300)
    const second = await world.delivery(360)
    const trip = await world.create([first, second])

    const dispatched = await world.dispatch(trip.tripId)

    expect(dispatched.state).toBe('DISPATCHED')
    const tasks = await prisma.deliveryTask.findMany({
      where: { id: { in: [first, second] } },
      select: { state: true },
    })
    // A run half-offered is a courier holding one order and a dispatcher
    // believing they hold two.
    expect(tasks.map((task) => task.state)).toEqual(['ASSIGNMENT_PENDING', 'ASSIGNMENT_PENDING'])
    expect(
      await prisma.deliveryAssignment.count({
        where: { deliveryTaskId: { in: [first, second] }, state: 'OFFERED' },
      }),
    ).toBe(2)
  })

  it('refuses to reshape a run that has already left', async () => {
    const world = await buildWorld('FROZEN')
    const first = await world.delivery(300)
    const second = await world.delivery(360)
    const trip = await world.create([first, second])
    await world.dispatch(trip.tripId)

    // Enforced by the database, not by the service: a rider already at the
    // second door cannot be given a better fourth stop, whichever code path
    // tries it.
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${world.tenantId}, true)`
        await transaction.deliveryTripStop.deleteMany({ where: { deliveryTripId: trip.tripId } })
      }),
    ).rejects.toThrow(/cannot change its stops/)
  })

  it('refuses to dispatch the same run twice', async () => {
    const world = await buildWorld('TWICE')
    const only = await world.delivery(300)
    const trip = await world.create([only])
    await world.dispatch(trip.tripId)

    await expect(world.dispatch(trip.tripId)).rejects.toMatchObject({
      code: 'INVALID_TRIP_TRANSITION',
    })
  })

  it('will not put two branches on one run', async () => {
    const world = await buildWorld('BRANCHES')
    const mine = await world.delivery(300)
    const theirs = await world.delivery(320, { secondBranch: true })

    await expect(world.create([mine, theirs])).rejects.toMatchObject({
      code: 'TRIP_BRANCH_MISMATCH',
    })
  })

  it('refuses a run that would deliver something late', async () => {
    const world = await buildWorld('LATE')
    const first = await world.delivery(4_000)
    const urgent = await world.delivery(4_200, {
      deliverBefore: new Date(NOW.getTime() + 4 * 60_000),
    })

    await expect(world.create([first, urgent])).rejects.toMatchObject({
      code: 'TRIP_WOULD_ARRIVE_LATE',
    })
  })

  it('will not batch a delivery that is already assigned', async () => {
    const world = await buildWorld('ASSIGNED')
    const taken = await world.delivery(300)
    await prisma.deliveryTask.update({ where: { id: taken }, data: { state: 'ASSIGNED' } })

    await expect(world.create([taken])).rejects.toMatchObject({
      code: 'DELIVERY_NOT_BATCHABLE',
    })
  })

  it('never proposes another tenant’s deliveries', async () => {
    const first = await buildWorld('TENANT1')
    const second = await buildWorld('TENANT2')
    const anchor = await first.delivery(300)
    await second.delivery(310)

    const proposal = await first.service.proposeTrip(first.tenantId, { anchorTaskId: anchor }, NOW)

    expect(proposal.stops).toHaveLength(1)
  })
})

async function buildWorld(label: string) {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const service = createPrismaDeliveryTripService(prisma)

  const tenant = await prisma.tenant.create({
    data: { slug: `tp-${suffix.toLowerCase()}`, name: `Trips ${suffix}` },
  })
  const tenantId = tenant.id
  const city = await prisma.city.create({
    data: { tenantId, code: `TC${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `TZ${suffix}`.slice(0, 16),
      nameFa: 'ناحیه',
      isActive: true,
    },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Bakery ${suffix}`,
      displayNameFa: 'نانوایی',
      partnerStatus: 'ACTIVE',
    },
  })
  const makeBranch = (code: string) =>
    prisma.bakeryBranch.create({
      data: {
        tenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `${code}${suffix}`.slice(0, 16),
        nameFa: 'شعبه',
        addressLine: 'نشانی',
        latitude: String(BRANCH.latitude),
        longitude: String(BRANCH.longitude),
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
  const branch = await makeBranch('TB')
  const otherBranch = await makeBranch('TO')
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+9895${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
    },
  })
  const partner = await prisma.courierPartner.create({
    data: { tenantId, code: `TP${suffix}`.slice(0, 16), displayName: 'پیک', isActive: true },
  })
  const courier = await prisma.courier.create({
    data: {
      tenantId,
      courierPartnerId: partner.id,
      displayName: 'پیک الف',
      status: 'AVAILABLE',
      mobileE164: `+9896${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
    },
  })
  const actor = await prisma.identityAccount.create({
    data: {
      mobileE164: `+9897${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
      status: 'ACTIVE',
    },
  })

  return {
    tenantId,
    service,

    /** One unassigned delivery, `metresNorth` from the branch. */
    async delivery(
      metresNorth: number,
      options: { deliverBefore?: Date; secondBranch?: boolean } = {},
    ): Promise<string> {
      const key = randomUUID()
      const target = options.secondBranch ? otherBranch : branch
      const order = await prisma.order.create({
        data: {
          tenantId,
          idempotencyKey: `tp-order-${key}`,
          customerId: customer.id,
          cityId: city.id,
          operationalZoneId: zone.id,
          bakeryBranchId: target.id,
          state: 'CONFIRMED',
          recipientNameSnapshot: 'گیرنده',
          recipientPhoneSnapshot: '+989121234567',
          deliveryAddressSnapshot: 'نشانی تحویل',
          deliveryLatitudeSnapshot: String(BRANCH.latitude + metresNorth / 111_000),
          deliveryLongitudeSnapshot: String(BRANCH.longitude),
          bakeryNameSnapshot: 'نانوایی',
          subtotalAmount: 500_000n,
          deliveryFeeAmount: 50_000n,
          totalAmount: 550_000n,
        },
      })
      const fulfillment = await prisma.fulfillment.create({
        data: {
          tenantId,
          orderId: order.id,
          bakeryBranchId: target.id,
          type: 'BAKERY_PICKUP_DELIVERY',
          state: 'PLANNED',
        },
      })
      const task = await prisma.deliveryTask.create({
        data: {
          tenantId,
          fulfillmentId: fulfillment.id,
          state: 'UNASSIGNED',
          ...(options.deliverBefore && { deliverBefore: options.deliverBefore }),
        },
      })
      return task.id
    },

    create(taskIds: readonly string[]) {
      return service.createTrip(tenantId, { accountId: actor.id }, { taskIds }, NOW, randomUUID())
    },

    dispatch(tripId: string) {
      return service.dispatchTrip(
        tenantId,
        { accountId: actor.id },
        { tripId, courierId: courier.id },
        NOW,
        randomUUID(),
      )
    },
  }
}
