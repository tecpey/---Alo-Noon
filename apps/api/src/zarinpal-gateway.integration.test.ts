import { randomUUID } from 'node:crypto'

import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  createPaymentProviderAdapterRegistry,
  normalizeInitializationResult,
  type ProviderConfigurationView,
} from '@alo-noon/domain'

import { startZarinpalSandbox, type SandboxTransaction } from '../scripts/zarinpal-sandbox'
import { createPrismaFinancialOperationsService } from './modules/financial-operations'
import { createPrismaAuthRepository, type AuthDependencies } from './modules/auth'
import { registerPaymentCallbackRoutes } from './modules/payment-callback'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaPaymentProviderService } from './modules/payment-provider'
import { createPrismaPaymentSettlementService } from './modules/payment-settlement'
import { createZarinpalAdapter } from './providers/zarinpal'

/**
 * The money path with a gateway on the other end of it.
 *
 * Everything between a placed order and a captured payment was already proven
 * piece by piece — the adapter against a mocked `fetch`, the settlement rule
 * against a stub adapter — but never joined up. The join is where the expensive
 * mistakes live: a parameter the gateway capitalises differently, an amount unit
 * that disagrees, a redirect that carries a reference nothing can match. Those
 * do not show up in a unit test, and finding them in production means finding
 * them with a customer's money.
 *
 * So this drives the whole chain against a server that answers in Zarinpal's v4
 * contract on Zarinpal's own paths: initialize, follow the customer's redirect,
 * receive the callback through the real route with the real host-based tenant
 * resolution, verify server to server, and capture. The gateway is a local
 * stand-in only because a CI runner cannot reach Zarinpal's sandbox; point
 * `PAYMENT_ZARINPAL_ENDPOINT` at the real one and the same code runs unchanged.
 *
 * Three outcomes are exercised, because the ones that must *not* move money
 * matter more than the one that must: a paid order captures, an amount mismatch
 * captures nothing, and a customer who backed out captures nothing.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const AMOUNT = 2_950_000n
const MERCHANT_ID = '00000000-0000-0000-0000-000000000000'
const RESULT_REDIRECT = 'https://alonoon.ir/payment/result'

afterAll(async () => prisma.$disconnect())

databaseDescribe('Zarinpal gateway end to end', () => {
  it('takes an order from unpaid to captured through the gateway', async () => {
    const world = await buildWorld('OK')
    try {
      const started = await world.startPayment()

      // The customer is sent to Zarinpal, not told they have paid.
      expect(started.state).toBe('CUSTOMER_ACTION_REQUIRED')
      expect(started.actionUrl).toContain('/pg/StartPay/')
      // Rial, unconverted, which is the single mistake that costs ten times the
      // order and cannot be taken back.
      expect(world.transactions.get(started.authority)?.requestedAmount).toBe(2_950_000)

      const callback = await world.payAtGateway(started.actionUrl)
      expect(callback.searchParams.get('Status')).toBe('OK')
      // Zarinpal capitalises its parameter; the callback route has to survive it.
      expect(callback.searchParams.get('Authority')).toBe(started.authority)

      const response = await world.deliverCallback(callback)
      // A neutral result page either way: the redirect promises nothing.
      expect(response.statusCode).toBe(303)
      expect(response.headers['location']).toContain(RESULT_REDIRECT)

      const payment = await prisma.payment.findFirstOrThrow({ where: { id: world.paymentId } })
      expect(payment.state).toBe('CAPTURED')
      const order = await prisma.order.findFirstOrThrow({ where: { id: world.orderId } })
      expect(order.paymentState).toBe('PAID')

      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: { tenantId: world.tenantId, providerReference: started.authority },
      })
      expect(attempt.state).toBe('VERIFIED')

      // One balanced journal for the exact amount, and no second one.
      const entries = await world.journalTotals()
      expect(entries).toEqual({ transactions: 1, debits: AMOUNT, credits: AMOUNT })

      // The customer refreshing the return page must not capture again.
      await world.deliverCallback(callback)
      expect(await world.journalTotals()).toEqual({
        transactions: 1,
        debits: AMOUNT,
        credits: AMOUNT,
      })
    } finally {
      await world.close()
    }
  })

  it('captures nothing when the gateway charged a different amount', async () => {
    // The gateway takes 10,000 Rial less than the order is for. Zarinpal answers
    // -50, and the money must stay where it is.
    const world = await buildWorld('SHORT', { chargeFor: (requested) => requested - 10_000 })
    try {
      const started = await world.startPayment()
      await world.deliverCallback(await world.payAtGateway(started.actionUrl))

      const payment = await prisma.payment.findFirstOrThrow({ where: { id: world.paymentId } })
      expect(payment.state).not.toBe('CAPTURED')
      const order = await prisma.order.findFirstOrThrow({ where: { id: world.orderId } })
      expect(order.paymentState).not.toBe('PAID')
      expect(await world.journalTotals()).toEqual({ transactions: 0, debits: 0n, credits: 0n })

      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: { tenantId: world.tenantId, providerReference: started.authority },
      })
      expect(attempt.state).toBe('REJECTED')
    } finally {
      await world.close()
    }
  })

  it('captures nothing when the customer backs out at the gateway', async () => {
    const world = await buildWorld('NOK')
    try {
      const started = await world.startPayment()
      const callback = await world.payAtGateway(`${started.actionUrl}?outcome=nok`)
      expect(callback.searchParams.get('Status')).toBe('NOK')

      // The callback still records — an abandoned payment is a fact worth
      // keeping — but the verdict comes from asking the gateway, which says -51.
      await world.deliverCallback(callback)

      const order = await prisma.order.findFirstOrThrow({ where: { id: world.orderId } })
      expect(order.paymentState).not.toBe('PAID')
      expect(await world.journalTotals()).toEqual({ transactions: 0, debits: 0n, credits: 0n })
    } finally {
      await world.close()
    }
  })

  it('recovers a payment whose callback arrived while the gateway was down', async () => {
    const world = await buildWorld('SWEEP')
    try {
      const started = await world.startPayment()
      const callback = await world.payAtGateway(started.actionUrl)

      // The gateway goes away between the customer returning and the
      // server-to-server verify. The receipt is recorded, nothing is captured,
      // and the customer is not told anything either way.
      await world.stopGateway()
      await world.deliverCallback(callback)
      expect(await world.journalTotals()).toEqual({ transactions: 0, debits: 0n, credits: 0n })

      // It comes back on the same port, still holding the transaction. The sweep
      // — not the customer — is what finishes the payment.
      await world.restartGateway()
      const swept = await world.settlement.settlePending(
        world.tenantId,
        10,
        new Date(),
        randomUUID(),
      )

      expect(swept.map((result) => result.status)).toContain('SETTLED')
      const order = await prisma.order.findFirstOrThrow({ where: { id: world.orderId } })
      expect(order.paymentState).toBe('PAID')
      expect(await world.journalTotals()).toEqual({
        transactions: 1,
        debits: AMOUNT,
        credits: AMOUNT,
      })
    } finally {
      await world.close()
    }
  })
})

interface StartedPayment {
  state: string
  actionUrl: string
  authority: string
}

interface World {
  tenantId: string
  orderId: string
  paymentId: string
  transactions: ReadonlyMap<string, SandboxTransaction>
  settlement: ReturnType<typeof createPrismaPaymentSettlementService>
  startPayment(): Promise<StartedPayment>
  payAtGateway(actionUrl: string): Promise<URL>
  deliverCallback(callback: URL): Promise<{ statusCode: number; headers: Record<string, unknown> }>
  journalTotals(): Promise<{ transactions: number; debits: bigint; credits: bigint }>
  stopGateway(): Promise<void>
  restartGateway(): Promise<void>
  close(): Promise<void>
}

/**
 * One tenant that can be paid, plus the gateway it pays through.
 *
 * Everything the payment path touches is built through the same services
 * production uses, because the schema defends itself: the payment, the provider
 * configuration, the attempt and the receipt each require audit and outbox rows
 * that a deferred constraint checks at commit, so a hand-inserted fixture is
 * rejected outright.
 */
async function buildWorld(
  label: string,
  options: { chargeFor?: (requestedAmount: number) => number } = {},
): Promise<World> {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const now = new Date()
  // The gateway's own ledger, held here so it survives the restart the sweep
  // case needs.
  const gatewayState = new Map<string, SandboxTransaction>()
  const startGateway = (port?: number) =>
    startZarinpalSandbox({
      state: gatewayState,
      ...(port !== undefined && { port }),
      ...(options.chargeFor && { chargeFor: options.chargeFor }),
    })
  let sandbox = await startGateway()
  const origin = sandbox.origin
  const gatewayPort = Number.parseInt(new URL(origin).port, 10)

  const tenant = await prisma.tenant.create({
    data: { slug: `zp-${suffix.toLowerCase()}`, name: `Zarinpal ${suffix}` },
  })
  const tenantId = tenant.id
  // Tenant identity comes from the verified host, exactly as it does in
  // production — the callback carries no session and no tenant parameter.
  const host = `zp-${suffix.toLowerCase()}.alonoon.test`
  await prisma.tenantDomain.create({
    data: { tenantId, host, isPrimary: true, verifiedAt: now },
  })

  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `zp-chart-${suffix}` },
    now,
    randomUUID(),
  )

  const city = await prisma.city.create({
    data: { tenantId, code: `ZC${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `ZZ${suffix}`.slice(0, 16),
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
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `ZB${suffix}`.slice(0, 16),
      nameFa: 'شعبه',
      addressLine: 'نشانی',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+9891${randomUUID().replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`,
    },
  })
  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: `zp-order-${suffix}`,
      customerId: customer.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      bakeryBranchId: branch.id,
      state: 'PENDING_CONFIRMATION',
      recipientNameSnapshot: 'گیرنده',
      recipientPhoneSnapshot: '+989121234567',
      deliveryAddressSnapshot: 'نشانی تحویل',
      deliveryLatitudeSnapshot: '36.5442',
      deliveryLongitudeSnapshot: '52.6781',
      bakeryNameSnapshot: 'نانوایی',
      subtotalAmount: AMOUNT,
      totalAmount: AMOUNT,
    },
  })
  const payment = await createPrismaPaymentLedgerService(prisma).initialize(
    tenantId,
    customer.id,
    { orderId: order.id, idempotencyKey: `zp-payment-${suffix}` },
    now,
    randomUUID(),
  )

  // The stand-in keeps its port across a restart, so one adapter serves the
  // whole run: the callback URL and the gateway origin stay pointed at each
  // other even while the gateway is down.
  const callbackUrl = `http://${host}/api/v1/payments/callback/zarinpal`
  const adapter = createZarinpalAdapter({ callbackUrl, endpointOrigin: origin })
  const registry = createPaymentProviderAdapterRegistry([adapter])

  const credential = () => {
    const material = new TextEncoder().encode(JSON.stringify({ merchantId: MERCHANT_ID }))
    return { material, dispose: () => material.fill(0) }
  }
  const secretResolver = Object.freeze({ testOnly: true, resolve: async () => credential() })

  const providerService = () =>
    createPrismaPaymentProviderService(prisma, {
      allowSystemOperations: true,
      adapterRegistry: registry,
    })

  const governance = providerService()
  const credentialReference = await governance.createCredentialReference(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode: 'ZARINPAL',
      reference: `local-encrypted://ZP${suffix}`,
      keyVersion: 'v1',
      metadata: {},
      idempotencyKey: `zp-credential-${suffix}`,
    },
    now,
    randomUUID(),
  )
  const configuration = await governance.createConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode: 'ZARINPAL',
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      merchantReference: `merchant-${suffix}`,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
      credentialReferenceId: credentialReference.id,
      idempotencyKey: `zp-config-${suffix}`,
      reason: 'Zarinpal gateway fixture',
    },
    now,
    randomUUID(),
  )
  await governance.governConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      targetActive: true,
      makeDefault: true,
      idempotencyKey: `zp-govern-${suffix}`,
      reason: 'Zarinpal gateway fixture',
    },
    now,
    randomUUID(),
  )
  await governance.setConfigurationHealth(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      healthStatus: 'HEALTHY',
      reason: 'Zarinpal gateway fixture',
    },
    now,
    randomUUID(),
  )

  const settlement = createPrismaPaymentSettlementService(prisma, {
    adapterRegistry: registry,
    secretResolver,
    ledgerService: createPrismaPaymentLedgerService(prisma),
    providerService: providerService(),
    verificationTimeoutMs: 4_000,
  })

  const attempt = await governance.createAttempt(
    tenantId,
    {
      paymentId: payment.id,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      idempotencyKey: `zp-attempt-${suffix}`,
    },
    now,
    randomUUID(),
  )

  const configurationView: ProviderConfigurationView = {
    id: configuration.id,
    tenantId,
    providerCode: 'ZARINPAL',
    adapterVersion: '1.0.0',
    adapterSpiVersion: 1,
    environment: 'TEST',
    merchantReference: `merchant-${suffix}`,
    callbackPolicy: 'SIGNED_ONLY',
    capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
    credentialReference: `local-encrypted://ZP${suffix}`,
  }

  const app: FastifyInstance = Fastify()
  registerPaymentCallbackRoutes(app, {
    // Only host resolution is reachable from a callback: it carries no session.
    auth: { repository: createPrismaAuthRepository(prisma) } as unknown as AuthDependencies,
    providerService: providerService(),
    settlementService: settlement,
    resultRedirectUrl: RESULT_REDIRECT,
    environment: 'TEST',
  })
  await app.ready()

  const world: World = {
    tenantId,
    orderId: order.id,
    paymentId: payment.id,
    transactions: gatewayState,
    settlement,

    /**
     * Asks the gateway for an authority, then records the attempt where the
     * customer's hand-off leaves it.
     *
     * The adapter is called directly rather than through the execution service
     * for one reason worth stating: the domain refuses to send a customer to
     * anything but an opaque HTTPS URL, and a local stand-in cannot be one. That
     * refusal is a real protection — a payment page over plain HTTP is a payment
     * page anyone on the path can rewrite — so the test bends around it instead
     * of relaxing it, and asserts it below rather than pretending it is absent.
     * The execution service's own orchestration is covered by its unit tests.
     */
    async startPayment() {
      const result = await adapter.initializePayment!({
        paymentAttemptId: attempt.id,
        amount: AMOUNT,
        currency: 'IRR',
        idempotencyKey: `zp-initialize-${suffix}`,
        requestFingerprint: `fingerprint-${suffix}`,
        timeoutMs: 4_000,
        configuration: configurationView,
        credential: credential(),
      })
      if (result.outcome !== 'CUSTOMER_ACTION_REQUIRED' || !result.providerReference) {
        throw new Error(`gateway refused the payment: ${JSON.stringify(result)}`)
      }
      const authority = result.providerReference

      // The customer is only ever sent somewhere the domain has approved.
      expect(() => normalizeInitializationResult(result, new Date())).toThrow(/opaque HTTPS URL/)

      for (const [index, state] of (
        ['INITIALIZATION_PENDING', 'INITIALIZED', 'CUSTOMER_ACTION_REQUIRED'] as const
      ).entries()) {
        await governance.transitionAttempt(
          tenantId,
          {
            paymentAttemptId: attempt.id,
            to: state,
            ...(state === 'INITIALIZED' && { providerReference: authority }),
            idempotencyKey: `zp-attempt-${suffix}-${index}`,
          },
          new Date(),
          randomUUID(),
        )
      }

      return {
        state: 'CUSTOMER_ACTION_REQUIRED',
        actionUrl: result.customerActionUrl!,
        authority,
      }
    },

    async payAtGateway(actionUrl) {
      const response = await fetch(actionUrl, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (!location) throw new Error('the gateway did not redirect the customer back')
      return new URL(location)
    },

    async deliverCallback(callback) {
      const response = await app.inject({
        method: 'GET',
        url: `${callback.pathname}${callback.search}`,
        headers: { host },
      })
      return { statusCode: response.statusCode, headers: response.headers }
    },

    async journalTotals() {
      const transactions = await prisma.financialTransaction.findMany({
        where: { paymentId: payment.id },
        include: { entries: true },
      })
      const entries = transactions.flatMap((transaction) => transaction.entries)
      const total = (side: 'DEBIT' | 'CREDIT') =>
        entries
          .filter((entry) => entry.side === side)
          .reduce((sum, entry) => sum + entry.amount, 0n)
      return {
        transactions: transactions.length,
        debits: total('DEBIT'),
        credits: total('CREDIT'),
      }
    },

    async stopGateway() {
      await sandbox.close()
    },

    async restartGateway() {
      sandbox = await startGateway(gatewayPort)
    },

    async close() {
      await app.close()
      await sandbox.close().catch(() => undefined)
    },
  }
  return world
}
