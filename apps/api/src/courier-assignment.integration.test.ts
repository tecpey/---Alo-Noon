import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import { createPrismaCourierAssignmentService } from './modules/courier-assignment'

/**
 * Pairing couriers to runs over a real database.
 *
 * The matching arithmetic is proved in the domain, including against brute
 * force. What can only be checked here is whether the inputs are honest: whether
 * a rider already holding an offer is counted as free, whether a batched trip
 * appears once or once per drop, whether a courier's position is read from the
 * delivery they actually completed, and whether another tenant's riders can be
 * proposed for our bread. Each of those would produce a confident, wrong plan
 * that no unit test would catch.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const BRANCH = { latitude: 36.5442, longitude: 52.6781 }
const NOW = new Date('2026-08-26T09:00:00.000Z')

afterAll(async () => prisma.$disconnect())

databaseDescribe('courier assignment over PostgreSQL', () => {
  it('pairs waiting deliveries with free couriers and writes nothing', async () => {
    const world = await buildWorld('BASIC')
    const near = await world.delivery(200)
    const courier = await world.courier('نزدیک', { lastDeliveryMetres: 250 })

    const proposal = await world.propose()

    expect(proposal.pairs).toHaveLength(1)
    expect(proposal.pairs[0]!.runId).toBe(near)
    expect(proposal.pairs[0]!.courierId).toBe(courier)
    expect(proposal.pairs[0]!.runKind).toBe('DELIVERY')
    // A proposal a dispatcher may ignore leaves nothing behind to ignore.
    expect(
      await prisma.deliveryAssignment.count({
        where: { tenantId: world.tenantId, state: 'OFFERED' },
      }),
    ).toBe(0)
    expect(await prisma.deliveryTask.findFirstOrThrow({ where: { id: near } })).toMatchObject({
      state: 'UNASSIGNED',
    })
  })

  it('says where a courier’s position came from', async () => {
    const world = await buildWorld('SOURCE')
    await world.delivery(200)
    await world.delivery(300)
    const known = await world.courier('پیک باسابقه', { lastDeliveryMetres: 250 })
    const fresh = await world.courier('پیک تازه')

    const proposal = await world.propose()

    const byCourier = new Map(proposal.pairs.map((pair) => [pair.courierId, pair]))
    // A dispatcher overruling the plan is entitled to know whether they are
    // overruling a measurement or an assumption.
    expect(byCourier.get(known)!.positionSource).toBe('LAST_DELIVERY')
    expect(byCourier.get(fresh)!.positionSource).toBe('UNKNOWN')
    expect(byCourier.get(known)!.approachMetres).toBeLessThan(1_000)
  })

  it('reads a courier’s position from the delivery they completed, not the one they were offered', async () => {
    const world = await buildWorld('POSITION')
    await world.delivery(100)
    // Two finished deliveries far apart. Only the later one is where they are.
    const courier = await world.courier('پیک', {
      lastDeliveryMetres: 8_000,
      earlierDeliveryMetres: 100,
    })

    const proposal = await world.propose()

    expect(proposal.pairs[0]!.courierId).toBe(courier)
    // Taking the earlier drop, or averaging the two, would put this rider at the
    // bakery's door when they are eight kilometres away.
    expect(proposal.pairs[0]!.approachMetres).toBeGreaterThan(7_000)
  })

  it('does not offer a run to a courier who is already holding one', async () => {
    const world = await buildWorld('BUSY')
    await world.delivery(200)
    const busy = await world.courier('مشغول')
    await world.hold(busy)
    const free = await world.courier('آزاد')

    const proposal = await world.propose()

    // A rider with an offer outstanding is about to be carrying bread. Counting
    // them as free is how one courier ends up promised to two customers.
    expect(proposal.pairs).toHaveLength(1)
    expect(proposal.pairs[0]!.courierId).toBe(free)
  })

  it('treats a batched trip as one run, not one per drop', async () => {
    const world = await buildWorld('TRIP')
    const first = await world.delivery(300)
    const second = await world.delivery(360)
    const tripId = await world.trip([first, second])
    await world.courier('پیک الف')
    await world.courier('پیک ب')

    const proposal = await world.propose()

    // Two couriers are free, but the two drops are one planned run. Offering
    // them separately would send two riders after the same loaves.
    expect(proposal.pairs).toHaveLength(1)
    expect(proposal.pairs[0]!.runId).toBe(tripId)
    expect(proposal.pairs[0]!.runKind).toBe('TRIP')
    expect(proposal.pairs[0]!.dropCount).toBe(2)
    expect(proposal.idleCourierCount).toBe(1)
  })

  it('leaves the newest work waiting when there are not enough couriers', async () => {
    const world = await buildWorld('SHORT')
    const oldest = await world.delivery(200, { createdAt: new Date(NOW.getTime() - 60 * 60_000) })
    const newest = await world.delivery(220, { createdAt: new Date(NOW.getTime() - 60_000) })
    await world.courier('تنها')

    const proposal = await world.propose()

    expect(proposal.pairs.map((pair) => pair.runId)).toEqual([oldest])
    expect(proposal.unassigned.map((run) => run.runId)).toEqual([newest])
  })

  it('reports what a one-at-a-time dispatcher would have ridden', async () => {
    const world = await buildWorld('BASELINE')
    // The trap, on two branches. A run waits at the far bakery, 140 metres up
    // the road, and another at the near one. Courier X is standing at the near
    // bakery; courier Y is 300 metres past both.
    await world.delivery(200, { secondBranch: true })
    await world.delivery(200)
    await world.courier('X', { lastDeliveryMetres: 0 })
    await world.courier('Y', { lastDeliveryMetres: 300 })

    const proposal = await world.propose()

    // Working down the list gives the far run to X, who is marginally nearer,
    // and then Y must ride the whole way to the near bakery. Solved together, Y
    // takes the far run and X is already standing where the near one is.
    const near = proposal.pairs.find((pair) => pair.branchId === world.branchId)!
    const far = proposal.pairs.find((pair) => pair.branchId !== world.branchId)!
    expect(near.approachMetres).toBe(0)
    expect(far.approachMetres).toBeLessThan(200)
    // The greedy figure is published beside the plan's own so the feature can be
    // judged rather than believed. On this board it is genuinely worse.
    expect(proposal.totalApproachMetres).toBeLessThan(proposal.greedyApproachMetres)
  })

  it('narrows to one branch when asked', async () => {
    const world = await buildWorld('BRANCH')
    const mine = await world.delivery(200)
    await world.delivery(220, { secondBranch: true })
    await world.courier('پیک')

    const proposal = await world.propose({ branchId: world.branchId })

    expect(proposal.pairs.map((pair) => pair.runId)).toEqual([mine])
    expect(proposal.unassigned).toEqual([])
  })

  it('refuses a branch that is not ours', async () => {
    const first = await buildWorld('OWNER')
    const second = await buildWorld('STRANGER')

    await expect(first.propose({ branchId: second.branchId })).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    })
  })

  it('never proposes another tenant’s couriers or another tenant’s work', async () => {
    const first = await buildWorld('TENANT1')
    const second = await buildWorld('TENANT2')
    const mine = await first.delivery(200)
    await second.delivery(210)
    const myCourier = await first.courier('مال ما')
    await second.courier('مال آنها')

    const proposal = await first.propose()

    expect(proposal.pairs).toHaveLength(1)
    expect(proposal.pairs[0]!.runId).toBe(mine)
    expect(proposal.pairs[0]!.courierId).toBe(myCourier)
    expect(proposal.idleCourierCount).toBe(0)
  })

  it('has nothing to say when nothing is waiting', async () => {
    const world = await buildWorld('EMPTY')
    await world.courier('بی‌کار')

    const proposal = await world.propose()

    expect(proposal.pairs).toEqual([])
    expect(proposal.unassigned).toEqual([])
    expect(proposal.totalApproachMetres).toBe(0)
    expect(proposal.idleCourierCount).toBe(1)
  })
})

async function buildWorld(label: string) {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const service = createPrismaCourierAssignmentService(prisma)

  const tenant = await prisma.tenant.create({
    data: { slug: `ca-${suffix.toLowerCase()}`, name: `Assign ${suffix}` },
  })
  const tenantId = tenant.id
  const city = await prisma.city.create({
    data: { tenantId, code: `AC${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `AZ${suffix}`.slice(0, 16),
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
  const makeBranch = (code: string, metresNorth: number) =>
    prisma.bakeryBranch.create({
      data: {
        tenantId,
        bakeryId: bakery.id,
        cityId: city.id,
        operationalZoneId: zone.id,
        code: `${code}${suffix}`.slice(0, 16),
        nameFa: 'شعبه',
        addressLine: 'نشانی',
        latitude: String(BRANCH.latitude + metresNorth / 111_000),
        longitude: String(BRANCH.longitude),
        operationalStatus: 'ACTIVE',
        qualityStatus: 'APPROVED',
      },
    })
  const branch = await makeBranch('AB', 0)
  // A second bakery 140 metres up the road. Runs are collected from a branch, so
  // two branches is the smallest board on which the pairing has anything to
  // decide: from one branch every rider faces the same ride whichever run they
  // take.
  const otherBranch = await makeBranch('AO', 140)
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+9895${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
    },
  })
  const partner = await prisma.courierPartner.create({
    data: { tenantId, code: `AP${suffix}`.slice(0, 16), displayName: 'پیک', isActive: true },
  })

  /** One delivery task, `metresNorth` from the branch, in whatever state is asked. */
  async function makeTask(
    metresNorth: number,
    options: { secondBranch?: boolean; createdAt?: Date; state?: 'UNASSIGNED' | 'DELIVERED' } = {},
  ): Promise<string> {
    const key = randomUUID()
    const target = options.secondBranch ? otherBranch : branch
    const order = await prisma.order.create({
      data: {
        tenantId,
        idempotencyKey: `ca-order-${key}`,
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
        state: options.state ?? 'UNASSIGNED',
        ...(options.createdAt && { createdAt: options.createdAt }),
      },
    })
    return task.id
  }

  return {
    tenantId,
    branchId: branch.id,

    /** One delivery waiting for a courier. */
    delivery(
      metresNorth: number,
      options: { secondBranch?: boolean; createdAt?: Date } = {},
    ): Promise<string> {
      return makeTask(metresNorth, options)
    },

    /**
     * One available courier, optionally with delivery history behind them. The
     * history is what stands in for a position feed, so it is built the way the
     * real thing arrives: a completed assignment against a delivered order.
     */
    async courier(
      displayName: string,
      history: { lastDeliveryMetres?: number; earlierDeliveryMetres?: number } = {},
    ): Promise<string> {
      const created = await prisma.courier.create({
        data: {
          tenantId,
          courierPartnerId: partner.id,
          displayName,
          status: 'AVAILABLE',
          mobileE164: `+9896${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
        },
      })
      if (history.earlierDeliveryMetres !== undefined) {
        const earlier = await makeTask(history.earlierDeliveryMetres, { state: 'DELIVERED' })
        await prisma.deliveryAssignment.create({
          data: {
            tenantId,
            deliveryTaskId: earlier,
            courierId: created.id,
            state: 'COMPLETED',
            offeredAt: new Date(NOW.getTime() - 180 * 60_000),
            endedAt: new Date(NOW.getTime() - 150 * 60_000),
          },
        })
      }
      if (history.lastDeliveryMetres !== undefined) {
        const last = await makeTask(history.lastDeliveryMetres, { state: 'DELIVERED' })
        await prisma.deliveryAssignment.create({
          data: {
            tenantId,
            deliveryTaskId: last,
            courierId: created.id,
            state: 'COMPLETED',
            offeredAt: new Date(NOW.getTime() - 60 * 60_000),
            endedAt: new Date(NOW.getTime() - 30 * 60_000),
          },
        })
      }
      return created.id
    },

    /** Puts an outstanding offer in this courier's hands. */
    async hold(courierId: string): Promise<void> {
      const task = await makeTask(500)
      await prisma.deliveryTask.update({
        where: { id: task },
        data: { state: 'ASSIGNMENT_PENDING' },
      })
      await prisma.deliveryAssignment.create({
        data: {
          tenantId,
          deliveryTaskId: task,
          courierId,
          state: 'OFFERED',
          offeredAt: new Date(NOW.getTime() - 60_000),
        },
      })
    },

    /** A planned run over several deliveries, as the batching service leaves it. */
    async trip(taskIds: readonly string[]): Promise<string> {
      const created = await prisma.deliveryTrip.create({
        data: {
          tenantId,
          bakeryBranchId: branch.id,
          state: 'PLANNED',
          plannedDepartureAt: NOW,
          plannedMetres: 700,
          savedMetres: 100,
          correlationId: randomUUID(),
          stops: {
            create: taskIds.map((taskId, index) => ({
              tenantId,
              deliveryTaskId: taskId,
              sequence: index + 1,
              legMetres: 300,
              plannedArrivalAt: new Date(NOW.getTime() + (index + 1) * 5 * 60_000),
            })),
          },
        },
      })
      return created.id
    },

    propose(command: { branchId?: string } = {}) {
      return service.proposeAssignments(tenantId, command, NOW)
    },
  }
}
