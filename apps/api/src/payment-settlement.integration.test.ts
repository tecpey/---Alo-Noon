import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  createPaymentProviderAdapterRegistry,
  type PaymentProviderAdapter,
  type ProviderVerificationResult,
} from '@alo-noon/domain'

import { createPrismaFinancialOperationsService } from './modules/financial-operations'

import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaPaymentProviderService } from './modules/payment-provider'
import {
  createPrismaPaymentSettlementService,
  type PaymentSettlementService,
} from './modules/payment-settlement'

/**
 * The settlement cycle end to end on PostgreSQL: a recorded callback becomes a
 * captured payment, a balanced journal, and a paid order — or, when the gateway's
 * answer cannot be reconciled, none of those.
 *
 * A stub adapter stands in for the gateway so each answer can be produced
 * exactly; the real adapters' HTTP handling is covered separately. What is real
 * here is everything that matters for correctness: the transactions, the
 * idempotency keys, the state machines, and the double-entry posting.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

afterAll(async () => prisma.$disconnect())

const AMOUNT = 2_950_000n

databaseDescribe('payment settlement over PostgreSQL', () => {
  it('captures a verified payment once, and stays settled when re-run', async () => {
    const scenario = await buildScenario('OK')
    const verify = vi.fn().mockResolvedValue(verified(scenario.providerReference))
    const service = settlementService(scenario, verify)

    const first = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(first.status).toBe('SETTLED')
    expect(first.capturedAmount).toBe(AMOUNT)

    const payment = await prisma.payment.findFirstOrThrow({ where: { id: scenario.paymentId } })
    expect(payment.state).toBe('CAPTURED')
    const order = await prisma.order.findFirstOrThrow({ where: { id: scenario.orderId } })
    expect(order.paymentState).toBe('PAID')

    // One balanced journal, debits equal to credits equal to the amount.
    const transactions = await prisma.financialTransaction.findMany({
      where: { paymentId: scenario.paymentId },
      include: { entries: true },
    })
    expect(transactions).toHaveLength(1)
    const entries = transactions[0]!.entries
    const debits = entries
      .filter((entry) => entry.side === 'DEBIT')
      .reduce((total, entry) => total + entry.amount, 0n)
    const credits = entries
      .filter((entry) => entry.side === 'CREDIT')
      .reduce((total, entry) => total + entry.amount, 0n)
    expect(debits).toBe(AMOUNT)
    expect(credits).toBe(AMOUNT)

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { id: scenario.attemptId },
    })
    expect(attempt.state).toBe('VERIFIED')

    // Re-running must not ask the gateway again, and must not post twice.
    const second = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )
    expect(second.status).toBe('SETTLED')
    expect(verify).toHaveBeenCalledTimes(1)
    expect(
      await prisma.financialTransaction.count({ where: { paymentId: scenario.paymentId } }),
    ).toBe(1)
  })

  it('never captures when the gateway confirms a smaller amount', async () => {
    const scenario = await buildScenario('SHORT')
    const service = settlementService(
      scenario,
      vi.fn().mockResolvedValue(verified(scenario.providerReference, 1_000n)),
    )

    const result = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(result.status).toBe('QUARANTINED')
    expect(result.reasonCode).toBe('SETTLEMENT_AMOUNT_MISMATCH')
    expect(result.capturedAmount).toBeNull()

    const payment = await prisma.payment.findFirstOrThrow({ where: { id: scenario.paymentId } })
    expect(payment.state).toBe('CREATED')
    const order = await prisma.order.findFirstOrThrow({ where: { id: scenario.orderId } })
    expect(order.paymentState).toBe('NOT_STARTED')
    expect(
      await prisma.financialTransaction.count({ where: { paymentId: scenario.paymentId } }),
    ).toBe(0)

    const receipt = await prisma.paymentCallbackReceipt.findFirstOrThrow({
      where: { id: scenario.receiptId },
    })
    expect(receipt.processingStatus).toBe('REJECTED')

    // The reason an operator needs is on the audit trail, named plainly.
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        tenantId: scenario.tenantId,
        entityId: scenario.receiptId,
        action: 'payment.callback_settlement_decided',
      },
    })
    expect(audit.metadata).toMatchObject({
      reasonCode: 'SETTLEMENT_AMOUNT_MISMATCH',
      verified: false,
    })
  })

  it('never captures when the gateway confirms a different transaction', async () => {
    const scenario = await buildScenario('SWAP')
    const service = settlementService(
      scenario,
      vi.fn().mockResolvedValue(verified('someone-elses-transaction')),
    )

    const result = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(result.status).toBe('QUARANTINED')
    expect(result.reasonCode).toBe('SETTLEMENT_REFERENCE_MISMATCH')
    expect(
      await prisma.financialTransaction.count({ where: { paymentId: scenario.paymentId } }),
    ).toBe(0)
  })

  it('rejects terminally when the gateway says the payment failed', async () => {
    const scenario = await buildScenario('FAIL')
    const service = settlementService(
      scenario,
      vi.fn().mockResolvedValue({ verified: false, normalizedOutcome: 'REJECTED' }),
    )

    const result = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(result.status).toBe('REJECTED')
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { id: scenario.attemptId },
    })
    expect(attempt.state).toBe('REJECTED')
    const payment = await prisma.payment.findFirstOrThrow({ where: { id: scenario.paymentId } })
    expect(payment.state).toBe('CREATED')
  })

  it('leaves a still-pending payment untouched so the sweep can retry it', async () => {
    const scenario = await buildScenario('PEND')
    const verify = vi.fn().mockResolvedValue({ verified: false, normalizedOutcome: 'PENDING' })
    const service = settlementService(scenario, verify)

    const result = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(result.status).toBe('PENDING')
    const receipt = await prisma.paymentCallbackReceipt.findFirstOrThrow({
      where: { id: scenario.receiptId },
    })
    // Still unprocessed, which is what makes it eligible for the sweep.
    expect(receipt.processingStatus).toBe('RECEIVED')
    expect(receipt.processingIdempotencyKey).toBeNull()

    // And the sweep does pick it up, this time with a verdict.
    verify.mockResolvedValue(verified(scenario.providerReference))
    const swept = await service.settlePending(scenario.tenantId, 10, new Date(), randomUUID())
    const settled = swept.find((entry) => entry.callbackReceiptId === scenario.receiptId)
    expect(settled?.status).toBe('SETTLED')
  })

  it('recovers when the process dies after capture but before bookkeeping', async () => {
    const scenario = await buildScenario('CRASH')
    const verify = vi.fn().mockResolvedValue(verified(scenario.providerReference))
    // Capture runs first by design; this simulates dying immediately after it.
    const crashing = settlementService(scenario, verify)
    await expect(
      (async () => {
        const capturing = createPrismaPaymentSettlementService(prisma, {
          adapterRegistry: registryFor(scenario.providerCode, verify),
          secretResolver: stubResolver(),
          providerService: providerServiceFor(scenario.providerCode),
          ledgerService: {
            ...ledger(),
            // Let the money move, then fail before the bookkeeping that records
            // it — the crash window the ordering is designed to survive.
            capture: async (...args: Parameters<ReturnType<typeof ledger>['capture']>) => {
              await ledger().capture(...args)
              throw new Error('process died')
            },
          },
        })
        await capturing.settle(
          scenario.tenantId,
          { callbackReceiptId: scenario.receiptId },
          new Date(),
          randomUUID(),
        )
      })(),
    ).rejects.toThrow('process died')

    // Money moved, bookkeeping did not.
    expect(
      await prisma.financialTransaction.count({ where: { paymentId: scenario.paymentId } }),
    ).toBe(1)
    const midway = await prisma.paymentAttempt.findFirstOrThrow({
      where: { id: scenario.attemptId },
    })
    expect(midway.state).not.toBe('VERIFIED')

    // The next run sees the payment already captured and reports it settled,
    // without asking the gateway again or posting a second journal.
    const recovered = await crashing.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )
    expect(recovered.status).toBe('SETTLED')
    expect(
      await prisma.financialTransaction.count({ where: { paymentId: scenario.paymentId } }),
    ).toBe(1)
  })

  it('quarantines a callback that matches no attempt', async () => {
    const scenario = await buildScenario('ORPHAN', { orphanReceipt: true })
    const service = settlementService(scenario, vi.fn().mockResolvedValue(verified('unknown-tx')))

    const result = await service.settle(
      scenario.tenantId,
      { callbackReceiptId: scenario.receiptId },
      new Date(),
      randomUUID(),
    )

    expect(result.status).toBe('QUARANTINED')
    expect(result.reasonCode).toBe('SETTLEMENT_ATTEMPT_NOT_FOUND')
  })

  it('keeps an unreachable gateway from stranding the rest of the sweep', async () => {
    const scenario = await buildScenario('SWEEP')
    const service = settlementService(scenario, vi.fn().mockRejectedValue(new Error('ECONNRESET')))

    const swept = await service.settlePending(scenario.tenantId, 10, new Date(), randomUUID())
    const entry = swept.find((item) => item.callbackReceiptId === scenario.receiptId)
    expect(entry?.status).toBe('PENDING')
    expect(entry?.reasonCode).toBe('SETTLEMENT_PROVIDER_UNREACHABLE')
  })
})

function verified(providerReference: string, amount = AMOUNT): ProviderVerificationResult {
  return {
    verified: true,
    normalizedOutcome: 'VERIFIED',
    providerReference,
    settledAmount: amount,
  }
}

function stubResolver() {
  return {
    resolve: async () => ({
      material: new TextEncoder().encode(JSON.stringify({ apiKey: 'stub' })),
      dispose: () => undefined,
    }),
  }
}

function ledger() {
  return createPrismaPaymentLedgerService(prisma)
}

function registryFor(
  providerCode: string,
  verify: (...args: never[]) => Promise<ProviderVerificationResult>,
) {
  const adapter: PaymentProviderAdapter = {
    code: providerCode,
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set(['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION']),
    testOnly: true,
    mapProviderStatus: () => 'PENDING',
    // Present because the configuration declares the capability and governance
    // refuses a configuration no adapter can actually serve. Settlement never
    // calls it.
    initializePayment: async () => ({ outcome: 'CUSTOMER_ACTION_REQUIRED' as const }),
    verifyCallback: verify as NonNullable<PaymentProviderAdapter['verifyCallback']>,
  }
  return createPaymentProviderAdapterRegistry([adapter])
}

function providerServiceFor(providerCode: string) {
  return createPrismaPaymentProviderService(prisma, {
    allowSystemOperations: true,
    adapterRegistry: registryFor(providerCode, async () => {
      throw new Error('unused')
    }),
  })
}

function settlementService(
  scenario: Scenario,
  verify: (...args: never[]) => Promise<ProviderVerificationResult>,
): PaymentSettlementService {
  return createPrismaPaymentSettlementService(prisma, {
    adapterRegistry: registryFor(scenario.providerCode, verify),
    secretResolver: stubResolver(),
    ledgerService: ledger(),
    providerService: providerServiceFor(scenario.providerCode),
  })
}

interface Scenario {
  tenantId: string
  providerCode: string
  orderId: string
  paymentId: string
  attemptId: string
  receiptId: string
  providerReference: string
}

async function buildScenario(
  label: string,
  options: { orphanReceipt?: boolean } = {},
): Promise<Scenario> {
  const suffix = `${label}${randomUUID().slice(0, 6)}`.toUpperCase().replace(/-/g, '')
  const now = new Date()
  const tenant = await prisma.tenant.create({
    data: { slug: `settle-${suffix.toLowerCase()}`, name: `Settlement ${suffix}` },
  })
  const tenantId = tenant.id

  // The tenant's chart of accounts, provisioned the same way a real tenant's is
  // rather than hand-built, so capture posts into the accounts it will find in
  // production.
  await createPrismaFinancialOperationsService(prisma).provision(
    tenantId,
    { idempotencyKey: `settle-chart-${suffix}` },
    now,
    randomUUID(),
  )

  const city = await prisma.city.create({
    data: { tenantId, code: `ST${suffix}`.slice(0, 16), nameFa: 'شهر', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `SZ${suffix}`.slice(0, 16),
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
      code: `SB${suffix}`.slice(0, 16),
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
      idempotencyKey: `settle-order-${suffix}`,
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
  // Created through the ledger service: a database trigger requires the payment's
  // state to match a contiguous transition history, so a hand-inserted row is
  // rejected outright.
  const payment = await createPrismaPaymentLedgerService(prisma).initialize(
    tenantId,
    customer.id,
    { orderId: order.id, idempotencyKey: `settle-payment-${suffix}` },
    now,
    randomUUID(),
  )

  // Provider credential, configuration and attempt all go through the real
  // provider service. Database triggers require each to be accompanied by
  // committed audit and outbox records, so hand-inserted rows are rejected —
  // which is exactly the guarantee worth exercising here.
  const providerCode = `STUBPAY${suffix}`.slice(0, 32)
  const providerService = createPrismaPaymentProviderService(prisma, {
    allowSystemOperations: true,
    adapterRegistry: registryFor(providerCode, async () => {
      throw new Error('unused during provisioning')
    }),
  })
  const credentialReference = await providerService.createCredentialReference(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode,
      reference: `local-encrypted://${suffix}`,
      keyVersion: 'v1',
      metadata: {},
      idempotencyKey: `settle-credential-${suffix}`,
    },
    now,
    randomUUID(),
  )
  const configuration = await providerService.createConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerCode,
      adapterVersion: '1.0.0',
      adapterSpiVersion: 1,
      merchantReference: `merchant-${suffix}`,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      currency: 'IRR',
      callbackPolicy: 'SIGNED_ONLY',
      capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
      credentialReferenceId: credentialReference.id,
      idempotencyKey: `settle-config-${suffix}`,
      reason: 'Settlement integration fixture',
    },
    now,
    randomUUID(),
  )
  await providerService.governConfiguration(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      targetActive: true,
      makeDefault: true,
      idempotencyKey: `settle-govern-${suffix}`,
      reason: 'Settlement integration fixture',
    },
    now,
    randomUUID(),
  )
  await providerService.setConfigurationHealth(
    tenantId,
    {
      actor: 'SYSTEM',
      providerConfigurationId: configuration.id,
      healthStatus: 'HEALTHY',
      reason: 'Settlement integration fixture',
    },
    now,
    randomUUID(),
  )

  const attempt = await providerService.createAttempt(
    tenantId,
    {
      paymentId: payment.id,
      environment: 'TEST',
      paymentContext: 'CHECKOUT',
      idempotencyKey: `settle-attempt-${suffix}`,
    },
    now,
    randomUUID(),
  )

  // Walk the attempt to where it sits once the customer has been sent to the
  // gateway, recording the provider's reference on the way.
  const providerReference = `tx-${suffix}`
  for (const [index, state] of (
    ['INITIALIZATION_PENDING', 'INITIALIZED', 'CUSTOMER_ACTION_REQUIRED'] as const
  ).entries()) {
    await providerService.transitionAttempt(
      tenantId,
      {
        paymentAttemptId: attempt.id,
        to: state,
        ...(state === 'INITIALIZED' && { providerReference }),
        idempotencyKey: `settle-attempt-${suffix}-${index}`,
      },
      now,
      randomUUID(),
    )
  }

  // Recorded through the intake path the callback route uses, so the receipt
  // carries the audit and outbox records its trigger requires.
  const receipt = await providerService.receiveCallback(
    tenantId,
    {
      providerCode,
      environment: 'TEST',
      // An orphan receipt carries a reference no attempt claims.
      externalEventId: options.orphanReceipt ? `orphan-${suffix}` : providerReference,
      approvedHeaders: {},
      canonicalPayload: { id: providerReference },
      idempotencyKey: `settle-receipt-${suffix}`,
    },
    now,
    randomUUID(),
  )

  return {
    tenantId,
    providerCode,
    orderId: order.id,
    paymentId: payment.id,
    attemptId: attempt.id,
    receiptId: receipt.id,
    providerReference,
  }
}
