import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { ADMIN_PERMISSIONS } from '@alo-noon/domain'

import { createPrismaDeliveryService, type DeliveryService } from './modules/delivery'
import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaOrderOperationsService } from './modules/order-operations'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'

/**
 * A delivery from acceptance to doorstep, against PostgreSQL.
 *
 * The rules worth exercising against real rows are the ones about who may do
 * what. The domain already refuses a dispatcher marking a delivery complete;
 * what it cannot know is whether the courier tapping "delivered" is the courier
 * the order was offered to, and that is the check this file spends most of its
 * length on.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const ledger = createPrismaPaymentLedgerService(prisma)
const orders = createPrismaOrderOperationsService(prisma, { ledgerService: ledger })
const service: DeliveryService = createPrismaDeliveryService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-08T09:00:00.000Z')

interface Fixture {
  tenantId: string
  operatorId: string
  outsiderId: string
  orderId: string
  courierId: string
  courierAccountId: string
  otherCourierId: string
  restingCourierId: string
}

let fixture: Fixture
let taskId: string

afterAll(async () => prisma.$disconnect())

databaseDescribe('deliveries over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('opens a delivery the moment the order is accepted', async () => {
    await orders.accept(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { orderId: fixture.orderId, reason: 'پذیرش' },
      now,
      randomUUID(),
    )

    // Accepting an order *is* the commitment to deliver it. A board that only
    // shows orders someone already thought about hides the ones nobody has.
    const tasks = await service.listTasks(fixture.tenantId, true)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ state: 'UNASSIGNED', orderId: fixture.orderId })
    taskId = tasks[0]!.taskId
  })

  it('refuses an account that cannot dispatch', async () => {
    await expect(
      service.offer(
        fixture.tenantId,
        { accountId: fixture.outsiderId },
        { taskId, courierId: fixture.courierId },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_FORBIDDEN', status: 403 })
  })

  it('refuses to offer work to a courier who is not working', async () => {
    // Offering to someone still onboarding or marked unavailable is an order
    // that sits, and nobody finds out until the customer calls.
    await expect(
      service.offer(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        { taskId, courierId: fixture.restingCourierId },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'COURIER_UNAVAILABLE', status: 409 })
  })

  it('offers the delivery without promising the customer a courier yet', async () => {
    const task = await service.offer(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { taskId, courierId: fixture.courierId },
      now,
      randomUUID(),
    )
    expect(task.state).toBe('ASSIGNMENT_PENDING')

    // An offer nobody has accepted is not an assignment. Telling the customer
    // otherwise makes a promise on the courier's behalf.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } })
    expect(order.deliveryState).toBe('UNASSIGNED')
  })

  it('shows a courier only what was offered to them', async () => {
    const mine = await service.listCourierTasks(fixture.tenantId, {
      courierId: fixture.courierId,
    })
    expect(mine.map((task) => task.taskId)).toEqual([taskId])

    const theirs = await service.listCourierTasks(fixture.tenantId, {
      courierId: fixture.otherCourierId,
    })
    expect(theirs).toEqual([])
  })

  it('refuses a courier reporting on an order that is not theirs', async () => {
    // The check the domain cannot make: it knows a courier may report a pickup,
    // not that *this* courier holds *this* order.
    await expect(
      service.report(
        fixture.tenantId,
        { courierId: fixture.otherCourierId },
        { taskId, to: 'PICKED_UP' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_YOURS', status: 403 })
  })

  it('refuses a report before the offer has been accepted', async () => {
    await expect(
      service.report(
        fixture.tenantId,
        { courierId: fixture.courierId },
        { taskId, to: 'PICKED_UP' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_YOURS', status: 403 })
  })

  it('walks the delivery to the door once the courier accepts', async () => {
    const accepted = await service.respond(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId, accept: true },
      now,
      randomUUID(),
    )
    expect(accepted).toMatchObject({ state: 'ASSIGNED' })
    expect(accepted.courier?.courierId).toBe(fixture.courierId)

    const pickedUp = await service.report(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId, to: 'PICKED_UP' },
      now,
      randomUUID(),
    )
    expect(pickedUp.state).toBe('PICKED_UP')
    // The fulfillment moves with the task rather than being set by hand, so the
    // two cannot drift apart.
    const fulfillment = await prisma.fulfillment.findFirstOrThrow({
      where: { orderId: fixture.orderId },
    })
    expect(fulfillment.state).toBe('HANDED_OFF')
    expect(fulfillment.handoffAt).not.toBeNull()

    await service.report(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId, to: 'OUT_FOR_DELIVERY' },
      now,
      randomUUID(),
    )
    const delivered = await service.report(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId, to: 'DELIVERED' },
      now,
      randomUUID(),
    )
    expect(delivered.state).toBe('DELIVERED')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } })
    expect(order.deliveryState).toBe('DELIVERED')
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryTaskId: taskId, courierId: fixture.courierId },
    })
    expect(assignment.state).toBe('COMPLETED')
  })

  it('closes the order when the delivery closes it', async () => {
    // Until this existed an order sat at CONFIRMED forever while its delivery
    // read DELIVERED: nobody closed it, every report counting completed orders
    // undercounted, and the customer was never told it arrived.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } })
    expect(order.state).toBe('COMPLETED')

    // Through IN_FULFILLMENT on pickup, not straight to the end, so the order's
    // own history reads the way it actually happened.
    const walked = await prisma.orderStateTransition.findMany({
      where: { orderId: fixture.orderId },
      orderBy: { occurredAt: 'asc' },
      select: { toState: true, actorType: true },
    })
    expect(walked.map((entry) => entry.toState)).toContain('IN_FULFILLMENT')
    expect(walked.filter((entry) => entry.actorType === 'SYSTEM').length).toBeGreaterThan(0)
  })

  it('names the order on a delivery event so a customer can be told about it', async () => {
    // A delivery event is about an order without being keyed on one. Without the
    // id in its payload the notification path cannot find the customer, and the
    // "on its way" message reaches nobody.
    // Keyed on this run's own delivery. Asking for "any out-for-delivery event"
    // finds an earlier run's on a database that has been used twice, and then
    // passes or fails for reasons that have nothing to do with this test.
    const event = await prisma.domainEventOutbox.findFirst({
      where: {
        aggregateType: 'delivery_task',
        aggregateId: taskId,
        name: 'delivery.out_for_delivery',
      },
    })
    expect(event?.payload).toMatchObject({ orderId: fixture.orderId })
  })

  it('records who said it arrived', async () => {
    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: taskId, action: 'delivery.delivered' },
    })
    expect(audit?.actorType).toBe('COURIER')
    // A courier is not an identity account, so the courier's own id is what
    // answers "who said this arrived".
    expect(audit?.metadata).toMatchObject({ courierId: fixture.courierId })
  })

  it('will not reopen a delivery that is done', async () => {
    await expect(
      service.report(
        fixture.tenantId,
        { courierId: fixture.courierId },
        { taskId, to: 'FAILED', reasonCode: 'CHANGED_MY_MIND' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_YOURS', status: 403 })
  })

  it('needs a reason before it will record a failure', async () => {
    const second = await seedOrder(fixture, `second-${suffix}`)
    await orders.accept(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { orderId: second, reason: 'پذیرش دوم' },
      now,
      randomUUID(),
    )
    const task = (await service.listTasks(fixture.tenantId, true)).find(
      (entry) => entry.orderId === second,
    )!
    await service.offer(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { taskId: task.taskId, courierId: fixture.courierId },
      now,
      randomUUID(),
    )
    await service.respond(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId: task.taskId, accept: true },
      now,
      randomUUID(),
    )
    await service.report(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId: task.taskId, to: 'PICKED_UP' },
      now,
      randomUUID(),
    )

    // A failure with no reason gives a dispatcher nothing to decide with —
    // try again, call the customer, or refund.
    await expect(
      service.report(
        fixture.tenantId,
        { courierId: fixture.courierId },
        { taskId: task.taskId, to: 'FAILED' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FAILURE_REASON_REQUIRED', status: 422 })

    const failed = await service.report(
      fixture.tenantId,
      { courierId: fixture.courierId },
      { taskId: task.taskId, to: 'FAILED', reasonCode: 'NOBODY_HOME' },
      now,
      randomUUID(),
    )
    expect(failed).toMatchObject({ state: 'FAILED', attemptCount: 1 })

    // Nobody home at four is a reason to try at six, not a reason to keep the
    // customer's money and their bread.
    const reopened = await service.release(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { taskId: task.taskId, reason: 'تلاش دوباره' },
      now,
      randomUUID(),
    )
    expect(reopened.state).toBe('UNASSIGNED')
    expect(reopened.courier).toBeNull()
  })

  it('ends the delivery when the order is cancelled', async () => {
    const third = await seedOrder(fixture, `third-${suffix}`)
    await orders.accept(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { orderId: third, reason: 'پذیرش سوم' },
      now,
      randomUUID(),
    )
    await orders.cancelWithRefund(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { orderId: third, reason: 'لغو' },
      now,
      randomUUID(),
    )

    const task = await prisma.deliveryTask.findFirstOrThrow({
      where: { fulfillment: { orderId: third } },
    })
    expect(task.state).toBe('CANCELLED')
  })

  it('adds a courier who cannot be handed work until someone says so', async () => {
    const mobile = uniqueMobile()
    const created = await service.createCourier(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { displayName: 'پیک تازه', mobileE164: mobile },
      now,
      randomUUID(),
    )
    // A courier who can take an order the instant their name is typed is one
    // handed work before anyone checked they exist.
    expect(created).toMatchObject({ status: 'ONBOARDING', activeTasks: 0 })

    const task = await prisma.deliveryTask.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, state: 'UNASSIGNED' },
    })
    await expect(
      service.offer(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        { taskId: task.id, courierId: created.courierId },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'COURIER_UNAVAILABLE', status: 409 })

    const activated = await service.setCourierStatus(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { courierId: created.courierId, status: 'AVAILABLE' },
      now,
      randomUUID(),
    )
    expect(activated.status).toBe('AVAILABLE')
  })

  it('refuses a second courier on a number already on the roster', async () => {
    const mobile = uniqueMobile()
    await service.createCourier(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { displayName: 'یکی', mobileE164: mobile },
      now,
      randomUUID(),
    )
    // The number is how a courier signs in, so two records sharing one would
    // mean either a courier who cannot see their work or one who sees another's.
    await expect(
      service.createCourier(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        { displayName: 'دیگری', mobileE164: mobile },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'COURIER_ALREADY_EXISTS', status: 409 })
  })

  it('refuses a number nobody could sign in with', async () => {
    await expect(
      service.createCourier(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        { displayName: 'شماره غلط', mobileE164: '09121234567' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'COURIER_MOBILE_INVALID', status: 422 })
  })

  it('will not take a courier out of rotation while they are holding bread', async () => {
    const fourth = await seedOrder(fixture, `fourth-${suffix}`)
    await orders.accept(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { orderId: fourth, reason: 'پذیرش چهارم' },
      now,
      randomUUID(),
    )
    const task = (await service.listTasks(fixture.tenantId, true)).find(
      (entry) => entry.orderId === fourth,
    )!
    await service.offer(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { taskId: task.taskId, courierId: fixture.otherCourierId },
      now,
      randomUUID(),
    )
    await service.respond(
      fixture.tenantId,
      { courierId: fixture.otherCourierId },
      { taskId: task.taskId, accept: true },
      now,
      randomUUID(),
    )

    // Those orders would be left with nobody responsible and no way to report
    // on them. Release the work first.
    await expect(
      service.setCourierStatus(
        fixture.tenantId,
        { accountId: fixture.operatorId },
        { courierId: fixture.otherCourierId, status: 'UNAVAILABLE' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'COURIER_STILL_HOLDING_WORK', status: 409 })

    await service.release(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { taskId: task.taskId, reason: 'پیک رفت' },
      now,
      randomUUID(),
    )
    const rested = await service.setCourierStatus(
      fixture.tenantId,
      { accountId: fixture.operatorId },
      { courierId: fixture.otherCourierId, status: 'UNAVAILABLE' },
      now,
      randomUUID(),
    )
    expect(rested.status).toBe('UNAVAILABLE')
  })

  it('links a signed-in account to the courier it belongs to', async () => {
    const courier = await service.findCourierForAccount(fixture.tenantId, fixture.courierAccountId)
    expect(courier).toEqual({ courierId: fixture.courierId })

    // An account with no courier record is not a courier. That is a refusal,
    // not a lookup failure.
    expect(await service.findCourierForAccount(fixture.tenantId, fixture.outsiderId)).toBeNull()
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `dispatch-${suffix.toLowerCase()}`, name: `Dispatch ${suffix}` },
  })
  const tenantId = tenant.id

  const city = await prisma.city.create({
    data: { tenantId, code: `DSP-${suffix}`, nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `DSPZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Dispatch Bakery ${suffix}`,
      displayNameFa: 'نانوایی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `DSPB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: uniqueMobile() },
  })
  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `dispatch-provision-${suffix}` },
    now,
    randomUUID(),
  )

  const partner = await prisma.courierPartner.create({
    data: {
      tenantId,
      code: `DSPP-${suffix}`,
      displayName: 'شرکت پیک',
      isActive: true,
    },
  })
  const courierMobile = uniqueMobile()
  const courierAccount = await prisma.identityAccount.create({
    data: { mobileE164: courierMobile, verifiedAt: now },
  })
  const courier = await prisma.courier.create({
    data: {
      tenantId,
      courierPartnerId: partner.id,
      mobileE164: courierMobile,
      displayName: 'پیک اول',
      status: 'AVAILABLE',
    },
  })
  const otherCourier = await prisma.courier.create({
    data: {
      tenantId,
      courierPartnerId: partner.id,
      mobileE164: uniqueMobile(),
      displayName: 'پیک دوم',
      status: 'AVAILABLE',
    },
  })
  const restingCourier = await prisma.courier.create({
    data: {
      tenantId,
      courierPartnerId: partner.id,
      mobileE164: uniqueMobile(),
      displayName: 'پیک استراحت',
      status: 'UNAVAILABLE',
    },
  })

  const partial: Fixture = {
    tenantId,
    operatorId: await createAccount(tenantId, `DSP_OPERATOR_${suffix}`, [
      ADMIN_PERMISSIONS.ordersManage,
      ADMIN_PERMISSIONS.ordersRead,
    ]),
    outsiderId: await createAccount(tenantId, null, []),
    orderId: '',
    courierId: courier.id,
    courierAccountId: courierAccount.id,
    otherCourierId: otherCourier.id,
    restingCourierId: restingCourier.id,
  }

  context.set(tenantId, {
    branchId: branch.id,
    cityId: city.id,
    zoneId: zone.id,
    customerId: customer.id,
  })
  return { ...partial, orderId: await seedOrder(partial, `first-${suffix}`) }
}

interface OrderContext {
  branchId: string
  cityId: string
  zoneId: string
  customerId: string
}
const context = new Map<string, OrderContext>()

/** A paid order, taken all the way through the ledger so the trigger is happy. */
async function seedOrder(fixture: Pick<Fixture, 'tenantId'>, key: string): Promise<string> {
  const place = context.get(fixture.tenantId)!
  const order = await prisma.order.create({
    data: {
      tenantId: fixture.tenantId,
      idempotencyKey: key,
      customerId: place.customerId,
      bakeryBranchId: place.branchId,
      cityId: place.cityId,
      operationalZoneId: place.zoneId,
      state: 'PENDING_CONFIRMATION',
      recipientNameSnapshot: 'زهرا محمدی',
      recipientPhoneSnapshot: '+989120000000',
      bakeryNameSnapshot: 'نانوایی',
      deliveryAddressSnapshot: 'بابل، خیابان نان',
      deliveryLatitudeSnapshot: '36.5442',
      deliveryLongitudeSnapshot: '52.6781',
      subtotalAmount: 250_000n,
      deliveryFeeAmount: 0n,
      discountAmount: 0n,
      totalAmount: 250_000n,
      createdAt: now,
      updatedAt: now,
    },
  })

  const payment = await ledger.initialize(
    fixture.tenantId,
    place.customerId,
    { orderId: order.id, idempotencyKey: `dsp-init-${key}` },
    now,
    randomUUID(),
  )
  for (const to of ['PENDING', 'AUTHORIZED'] as const) {
    await ledger.transition(
      fixture.tenantId,
      { paymentId: payment.id, to, actor: 'SYSTEM', idempotencyKey: `dsp-${to}-${key}` },
      now,
      randomUUID(),
    )
  }
  await ledger.capture(
    fixture.tenantId,
    {
      paymentId: payment.id,
      idempotencyKey: `dsp-capture-${key}`,
      entries: [
        { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: 250_000n },
        { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: 250_000n },
      ],
    },
    now,
    randomUUID(),
  )
  return order.id
}

function uniqueMobile(): string {
  return `+989${randomUUID().replace(/\D/g, '').padEnd(9, '5').slice(0, 9)}`
}

async function createAccount(
  tenantId: string,
  roleCode: string | null,
  permissions: readonly string[],
): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: { mobileE164: uniqueMobile(), verifiedAt: now },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    await transaction.tenantMembership.create({
      data: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
    })
  })
  if (!roleCode) return account.id

  const role = await prisma.authorizationRole.upsert({
    where: { code: roleCode },
    update: {},
    create: { code: roleCode, name: roleCode },
  })
  for (const code of permissions) {
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: `Integration permission ${code}` },
    })
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })
  return account.id
}
