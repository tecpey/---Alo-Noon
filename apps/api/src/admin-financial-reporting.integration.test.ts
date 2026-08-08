import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { createPaymentProviderAdapterRegistry, type PaymentProviderAdapter } from '@alo-noon/domain'

import {
  AdminFinancialReportingError,
  createPrismaAdminFinancialReportingService,
  type AdminFinancialReportingService,
} from './modules/admin-financial-reporting'
import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaPaymentProviderService } from './modules/payment-provider'

/**
 * Exercises the financial aggregates against PostgreSQL with postings whose
 * sides are known, so the balance check is checked rather than assumed.
 *
 * Amounts are chosen to exceed the float-safe range once summed: a trial
 * balance that silently rounds is worse than no trial balance, because it
 * balances anyway.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const service: AdminFinancialReportingService = createPrismaAdminFinancialReportingService(prisma)

const suffix = randomUUID().slice(0, 8).toUpperCase()
const from = new Date('2026-05-01T00:00:00.000Z')
const to = new Date('2026-05-08T00:00:00.000Z')
const range = { from: from.toISOString(), to: to.toISOString() }

interface Fixture {
  tenantId: string
  otherTenantId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

databaseDescribe('admin financial reporting over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seedTenant()
  }, 60_000)

  it('balances the ledger without losing precision', async () => {
    const report = await service.financialReport(fixture.tenantId, range)
    const { trialBalance } = report

    // Two captures: 9,007,199,254,740,993 and 5,000,000 Rial, each posted as a
    // debit to cash clearing and a credit to the payment clearing liability.
    expect(trialBalance.totalDebits.amount).toBe('9007199259740993')
    expect(trialBalance.totalCredits.amount).toBe('9007199259740993')
    expect(trialBalance.balanced).toBe(true)
    // Beyond the float-safe range, so a Number round-trip would have shifted it.
    expect(Number(trialBalance.totalDebits.amount)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
  })

  it('signs each balance by what its account type means', async () => {
    const { trialBalance } = await service.financialReport(fixture.tenantId, range)
    const cash = trialBalance.rows.find((row) => row.accountCode === 'A_1100_CASH_CLEARING')
    const liability = trialBalance.rows.find((row) => row.accountCode === 'L_2100_PAYMENT_CLEARING')

    // An asset debited is positive; a liability credited is positive too, even
    // though its debits-minus-credits is negative.
    expect(cash?.accountType).toBe('ASSET')
    expect(cash?.balance.amount).toBe('9007199259740993')
    expect(liability?.accountType).toBe('LIABILITY')
    expect(liability?.balance.amount).toBe('9007199259740993')
  })

  it('omits accounts nothing was ever posted to', async () => {
    const { trialBalance } = await service.financialReport(fixture.tenantId, range)
    // The chart provisions accounts a pilot never touches; a page of zeroes
    // would bury the two that carry money.
    expect(trialBalance.rows).toHaveLength(2)
  })

  it('reconciles captured value against orders marked paid', async () => {
    const { settlement } = await service.financialReport(fixture.tenantId, range)
    expect(settlement.capturedCount).toBe(2)
    expect(settlement.capturedValue.amount).toBe('9007199259740993')
    expect(settlement.paidOrders).toBe(2)
    expect(settlement.paidOrderValue.amount).toBe('9007199259740993')
    // Everything captured is accounted for on the order side.
    expect(settlement.captureToOrderGap.amount).toBe('0')
  })

  it('reports the unprocessed receipt backlog with its oldest entry', async () => {
    const { settlement } = await service.financialReport(fixture.tenantId, range)
    expect(settlement.receipts.total).toBe(4)
    expect(settlement.receipts.processed).toBe(2)
    expect(settlement.receipts.rejected).toBe(1)
    expect(settlement.receipts.awaitingProcessing).toBe(1)
    expect(settlement.receipts.oldestAwaitingAt).toBe('2026-05-04T09:00:00.000Z')
  })

  it('breaks the attempt funnel down by gateway', async () => {
    const { providers } = await service.financialReport(fixture.tenantId, range)
    const idpay = providers.find((row) => row.providerCode === 'IDPAY')
    expect(idpay?.attempts).toBe(4)
    expect(idpay?.verified).toBe(2)
    expect(idpay?.rejected).toBe(1)
    expect(idpay?.failed).toBe(1)
    expect(idpay?.inFlight).toBe(0)
    expect(idpay?.verificationRate).toBe(0.5)
  })

  it('refuses an inverted or absurdly wide range', async () => {
    await expect(
      service.financialReport(fixture.tenantId, {
        from: to.toISOString(),
        to: from.toISOString(),
      }),
    ).rejects.toBeInstanceOf(AdminFinancialReportingError)

    await expect(
      service.financialReport(fixture.tenantId, {
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' })
  })

  it('does not show one tenant the other tenant books', async () => {
    const report = await service.financialReport(fixture.otherTenantId, range)
    expect(report.trialBalance.rows).toEqual([])
    expect(report.trialBalance.balanced).toBe(true)
    expect(report.settlement.capturedValue.amount).toBe('0')
    expect(report.providers).toEqual([])
  })
})

async function seedTenant(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `fin-${suffix.toLowerCase()}`, name: `Financial ${suffix}` },
  })
  const other = await prisma.tenant.create({
    data: { slug: `fin-other-${suffix.toLowerCase()}`, name: `Financial other ${suffix}` },
  })
  const tenantId = tenant.id

  // The real chart, through the service that owns it. Hand-inserting accounts
  // trips the database's own invariant that a system root is non-postable, and
  // the whole point of this report is that it reads the chart the business runs
  // on rather than a convenient stand-in.
  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `financial-report-${suffix}-provision` },
    from,
    randomUUID(),
  )

  const city = await prisma.city.create({
    data: { tenantId, code: `FIN-${suffix}`, nameFa: 'شهر مالی', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `FINZ-${suffix}`, nameFa: 'ناحیه', isActive: true },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Financial Bakery ${suffix}`,
      displayNameFa: 'نانوایی مالی',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `FINB-${suffix}`,
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: { tenantId, mobileE164: `+9891${suffix.replace(/\D/g, '1').padEnd(8, '6').slice(0, 8)}` },
  })
  // Credentials and configurations carry audit and outbox pairings that
  // deferred database constraints check at commit, so they go through the
  // service that owns them rather than being inserted by hand.
  await provisionGateway(tenantId)

  // Two captured orders, chosen so the total crosses the float-safe boundary.
  const captures: Array<{ amount: bigint; day: string }> = [
    { amount: 9_007_199_254_740_993n, day: '2026-05-02T09:00:00.000Z' },
    { amount: 5_000_000n, day: '2026-05-03T09:00:00.000Z' },
  ]

  // Capture goes through the ledger service rather than hand-written rows. The
  // schema defends itself — an order cannot claim PAID without exactly one
  // captured transaction behind it — and going through the real path means this
  // report is measured against the rows production actually writes.
  const ledger = createPrismaPaymentLedgerService(prisma)
  let index = 0
  for (const capture of captures) {
    const posted = new Date(capture.day)
    const order = await createOrder(tenantId, {
      customerId: customer.id,
      branchId: branch.id,
      cityId: city.id,
      zoneId: zone.id,
      total: capture.amount,
      at: posted,
      key: `fin-order-${suffix}-${index}`,
    })
    const payment = await ledger.initialize(
      tenantId,
      customer.id,
      { orderId: order, idempotencyKey: `fin-init-${suffix}-${index}` },
      posted,
      randomUUID(),
    )
    // The attempt is created before capture, as in production: a captured
    // payment is finished, and the service refuses to open a new attempt
    // against one.
    await createAttempt(tenantId, payment.id, 'VERIFIED', posted, `${suffix}-${index}`)
    for (const to of ['PENDING', 'AUTHORIZED'] as const) {
      await ledger.transition(
        tenantId,
        {
          paymentId: payment.id,
          to,
          actor: 'SYSTEM',
          idempotencyKey: `fin-${to.toLowerCase()}-${suffix}-${index}`,
        },
        posted,
        randomUUID(),
      )
    }
    await ledger.capture(
      tenantId,
      {
        paymentId: payment.id,
        idempotencyKey: `fin-capture-${suffix}-${index}`,
        entries: [
          { accountCode: 'A_1100_CASH_CLEARING', side: 'DEBIT', amount: capture.amount },
          { accountCode: 'L_2100_PAYMENT_CLEARING', side: 'CREDIT', amount: capture.amount },
        ],
      },
      posted,
      randomUUID(),
    )
    // `Payment.createdAt` is a database default the service does not set, so a
    // fixture cannot place a payment in the past through the service alone.
    // Backdated here only so the by-state breakdown has something to bucket; in
    // production the two clocks coincide.
    await prisma.$executeRaw`
      UPDATE "Payment" SET "createdAt" = ${posted} WHERE "id" = ${payment.id}::uuid`
    index += 1
  }

  // A rejected and a failed attempt, so the funnel has something other than
  // success in it, plus an unrelated payment to hang them from.
  const spare = await sparePayment(tenantId, customer.id, branch.id, city.id, zone.id, suffix)
  await createAttempt(
    tenantId,
    spare,
    'REJECTED',
    new Date('2026-05-04T09:00:00.000Z'),
    `${suffix}-rejected`,
  )
  await createAttempt(
    tenantId,
    spare,
    'FAILED',
    new Date('2026-05-05T09:00:00.000Z'),
    `${suffix}-failed`,
  )

  // Four receipts: two settled, one refused, one still waiting for the sweep.
  // Intake and verdict both go through the provider service, which writes the
  // audit and outbox records their trigger requires at commit.
  const receipts: Array<{ verdict: 'PROCESSED' | 'REJECTED' | null; at: string }> = [
    { verdict: 'PROCESSED', at: '2026-05-02T09:05:00.000Z' },
    { verdict: 'PROCESSED', at: '2026-05-03T09:05:00.000Z' },
    { verdict: 'REJECTED', at: '2026-05-03T10:00:00.000Z' },
    { verdict: null, at: '2026-05-04T09:00:00.000Z' },
  ]
  for (const [order, receipt] of receipts.entries()) {
    const at = new Date(receipt.at)
    const reference = `receipt-${suffix}-${order}`
    const recorded = await providerService.receiveCallback(
      tenantId,
      {
        providerCode: PROVIDER_CODE,
        environment: 'TEST',
        externalEventId: reference,
        approvedHeaders: {},
        canonicalPayload: { id: reference },
        idempotencyKey: `fin-receipt-${suffix}-${order}`,
      },
      at,
      randomUUID(),
    )
    if (!receipt.verdict) continue
    await providerService.concludeCallback(
      tenantId,
      {
        callbackReceiptId: recorded.id,
        verified: receipt.verdict === 'PROCESSED',
        reasonCode: receipt.verdict === 'PROCESSED' ? 'SETTLED' : 'AMOUNT_MISMATCH',
        idempotencyKey: `fin-verdict-${suffix}-${order}`,
      },
      at,
      randomUUID(),
    )
  }

  return { tenantId, otherTenantId: other.id }
}

/** The stub gateway the funnel is measured against. */
const PROVIDER_CODE = `IDPAY`

const adapter: PaymentProviderAdapter = {
  code: PROVIDER_CODE,
  adapterVersion: '1.0.0',
  spiVersion: 1,
  capabilities: new Set(['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION']),
  testOnly: true,
  mapProviderStatus: () => 'PENDING',
  initializePayment: async () => ({ outcome: 'CUSTOMER_ACTION_REQUIRED' as const }),
  // Present because the configuration declares the capability, and governance
  // refuses a configuration no installed adapter can actually serve. This
  // fixture concludes receipts directly, so it is never called.
  verifyCallback: async () => {
    throw new Error('unused by the financial reporting fixture')
  },
}

/**
 * Attempts and receipts both carry audit and outbox pairings that deferred
 * constraints check at commit, and an attempt's state must match a contiguous
 * transition history — so both go through the service that owns them.
 */
const providerService = createPrismaPaymentProviderService(prisma, {
  allowSystemOperations: true,
  adapterRegistry: createPaymentProviderAdapterRegistry([adapter]),
})

async function provisionGateway(tenantId: string): Promise<{ id: string }> {
  const credential = await providerService.createCredentialReference(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode: PROVIDER_CODE,
      reference: `local-encrypted://FIN${suffix}`,
      keyVersion: 'v1',
      metadata: {},
      idempotencyKey: `fin-credential-${suffix}`,
    },
    from,
    randomUUID(),
  )
  const configuration = await providerService.createConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode: PROVIDER_CODE,
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      merchantReference: `merchant-${suffix}`,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
      credentialReferenceId: credential.id,
      idempotencyKey: `fin-config-${suffix}`,
      reason: 'Financial reporting fixture',
    },
    from,
    randomUUID(),
  )

  // A gateway is not selectable until it is both active and attested healthy,
  // so the fixture does what an operator would have to do before any payment
  // could reach it.
  await providerService.governConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      targetActive: true,
      makeDefault: true,
      idempotencyKey: `fin-govern-${suffix}`,
      reason: 'Financial reporting fixture',
    },
    from,
    randomUUID(),
  )
  await providerService.setConfigurationHealth(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      healthStatus: 'HEALTHY',
      reason: 'Financial reporting fixture',
    },
    from,
    randomUUID(),
  )
  return configuration
}

async function createOrder(
  tenantId: string,
  input: {
    customerId: string
    branchId: string
    cityId: string
    zoneId: string
    total: bigint
    at: Date
    key: string
  },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: input.key,
      customerId: input.customerId,
      bakeryBranchId: input.branchId,
      cityId: input.cityId,
      operationalZoneId: input.zoneId,
      // The ledger only initializes a payment for an order awaiting
      // confirmation with nothing paid yet — the same gate checkout passes
      // through — so the fixture starts there rather than at CONFIRMED.
      state: 'PENDING_CONFIRMATION',
      recipientNameSnapshot: 'گیرنده',
      recipientPhoneSnapshot: '+989120000000',
      bakeryNameSnapshot: 'نانوایی مالی',
      deliveryAddressSnapshot: 'نشانی',
      deliveryLatitudeSnapshot: '36.5442',
      deliveryLongitudeSnapshot: '52.6781',
      subtotalAmount: input.total,
      deliveryFeeAmount: 0n,
      discountAmount: 0n,
      totalAmount: input.total,
      createdAt: input.at,
      updatedAt: input.at,
    },
  })
  return order.id
}

/**
 * An order that never gets paid, so the rejected and failed attempts have
 * something to hang from. A captured payment is finished and refuses new
 * attempts, which is why they cannot share the two above.
 */
async function sparePayment(
  tenantId: string,
  customerId: string,
  branchId: string,
  cityId: string,
  zoneId: string,
  label: string,
): Promise<string> {
  const at = new Date('2026-05-04T08:00:00.000Z')
  const order = await createOrder(tenantId, {
    customerId,
    branchId,
    cityId,
    zoneId,
    total: 100_000n,
    at,
    key: `fin-order-${label}-spare`,
  })
  const payment = await createPrismaPaymentLedgerService(prisma).initialize(
    tenantId,
    customerId,
    { orderId: order, idempotencyKey: `fin-init-${label}-spare` },
    at,
    randomUUID(),
  )
  return payment.id
}

/**
 * An attempt walked to a terminal state through the states it must pass.
 *
 * A trigger requires an attempt's state to match a contiguous transition
 * history, so it cannot be born terminal — which is the invariant that makes
 * the funnel's counts meaningful in the first place.
 */
async function createAttempt(
  tenantId: string,
  paymentId: string,
  state: 'VERIFIED' | 'REJECTED' | 'FAILED',
  at: Date,
  label: string,
): Promise<void> {
  const attempt = await providerService.createAttempt(
    tenantId,
    {
      paymentId,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      idempotencyKey: `fin-attempt-${label}`,
    },
    at,
    randomUUID(),
  )

  // As far as a plain transition is allowed to go. Reaching VERIFIED or
  // REJECTED is settlement's business, not a state anyone may simply assert,
  // so the last hop goes through `settleAttempt`.
  const path =
    state === 'FAILED'
      ? (['INITIALIZATION_PENDING', 'FAILED'] as const)
      : ([
          'INITIALIZATION_PENDING',
          'INITIALIZED',
          'CUSTOMER_ACTION_REQUIRED',
          'CALLBACK_RECEIVED',
        ] as const)

  for (const [index, to] of path.entries()) {
    await providerService.transitionAttempt(
      tenantId,
      {
        paymentAttemptId: attempt.id,
        to,
        ...(to === 'INITIALIZED' && { providerReference: `tx-${label}` }),
        idempotencyKey: `fin-attempt-${label}-${index}`,
      },
      at,
      randomUUID(),
    )
  }
  if (state === 'FAILED') return

  await providerService.settleAttempt(
    tenantId,
    {
      paymentAttemptId: attempt.id,
      outcome: state,
      normalizedOutcome: state,
      idempotencyKey: `fin-settle-${label}`,
    },
    at,
    randomUUID(),
  )
}
