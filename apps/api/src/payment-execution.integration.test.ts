import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import {
  createPaymentProviderAdapterRegistry,
  createProviderExecutionPolicy,
  type PaymentProviderAdapter,
  type ProviderInitializationResult,
} from '@alo-noon/domain'

import {
  createPrismaPaymentExecutionService,
  paymentExecutionRequestKey,
  type PaymentExecutionService,
} from './modules/payment-execution'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaPaymentProviderService } from './modules/payment-provider'

const databaseDescribe = process.env['DATABASE_URL'] ? describe.sequential : describe.skip
const prisma = new PrismaClient()
const tenantId = randomUUID()
const now = new Date('2026-08-04T09:00:00.000Z')

let customerId = ''
let paymentId = ''
let configurationId = ''
let providerCode = ''
let adapterInvocations = 0
let disposedCredentials = 0
let lastCredentialMaterial: Uint8Array | undefined
let adapterResult: ProviderInitializationResult = {
  outcome: 'PERMANENT_FAILURE',
  normalizedCode: 'TEST_RESULT_NOT_CONFIGURED',
}
let service: PaymentExecutionService

afterAll(async () => prisma.$disconnect())

databaseDescribe('payment execution orchestrator on PostgreSQL', () => {
  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `payment-execution-${suffix.toLowerCase()}`,
        name: `Payment Execution ${suffix}`,
        status: 'ACTIVE',
      },
    })
    providerCode = `EXEC_GATEWAY_${suffix}`
    const payment = await createPayment(suffix, now)
    customerId = payment.customerId
    paymentId = payment.id
    const adapter = testAdapter()
    const registry = createPaymentProviderAdapterRegistry([adapter])
    const operatorId = await createFinancialOperator(suffix, now)
    const providerService = createPrismaPaymentProviderService(prisma, {
      allowSystemOperations: true,
      adapterRegistry: registry,
    })
    const credential = await providerService.createCredentialReference(
      tenantId,
      {
        actor: 'STAFF',
        actorId: operatorId,
        providerCode,
        reference: `vault://alo-noon/${tenantId}/${providerCode}`,
        keyVersion: 'v1',
        metadata: { purpose: 'payment-initialization' },
        idempotencyKey: `execution-credential-${suffix}`,
      },
      now,
      randomUUID(),
    )
    const configuration = await providerService.createConfiguration(
      tenantId,
      {
        actor: 'STAFF',
        actorId: operatorId,
        providerCode,
        adapterVersion: '1.0.0',
        adapterSpiVersion: 1,
        merchantReference: `merchant-${suffix}`,
        environment: 'TEST',
        paymentContext: 'CHECKOUT',
        currency: 'IRR',
        callbackPolicy: 'SIGNED_ONLY',
        capabilities: ['PAYMENT_INITIALIZATION'],
        credentialReferenceId: credential.id,
        idempotencyKey: `execution-configuration-${suffix}`,
        reason: 'Provision orchestrator integration provider',
      },
      now,
      randomUUID(),
    )
    configurationId = configuration.id
    await prisma.paymentProviderConfiguration.update({
      where: { id: configuration.id },
      data: { healthStatus: 'HEALTHY' },
    })
    await providerService.governConfiguration(
      tenantId,
      {
        actor: 'STAFF',
        actorId: operatorId,
        providerConfigurationId: configuration.id,
        targetActive: true,
        makeDefault: true,
        idempotencyKey: `execution-activate-${suffix}`,
        reason: 'Activate orchestrator integration provider',
      },
      new Date(now.getTime() + 1_000),
      randomUUID(),
    )
    service = executionService(registry)
  })

  it('persists a normalized customer-action result without capture, ledger posting, or secret leakage', async () => {
    const key = `execution-action-${randomUUID()}`
    adapterResult = {
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: `provider-${randomUUID()}`,
      customerActionUrl: 'https://pay.example.test/action?token=opaque',
      actionExpiresAt: new Date(now.getTime() + 10 * 60_000),
      customerMessageKey: 'payment.continue',
    }
    const result = await service.initialize(
      tenantId,
      { type: 'CUSTOMER', id: customerId },
      { paymentId, idempotencyKey: key },
      now,
      randomUUID(),
    )
    expect(result).toMatchObject({
      paymentId,
      providerConfigurationId: configurationId,
      providerCode,
      state: 'CUSTOMER_ACTION_REQUIRED',
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      replayed: false,
      customerAction: { url: 'https://pay.example.test/action?token=opaque' },
    })
    expect(disposedCredentials).toBe(1)
    expect([...lastCredentialMaterial!]).toEqual(new Array(lastCredentialMaterial!.length).fill(0))

    const [payment, transitions, financialTransactions, audits, outbox] = await Promise.all([
      prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      }),
      prisma.paymentAttemptStateTransition.findMany({
        where: { paymentAttemptId: result.paymentAttemptId },
        orderBy: { version: 'asc' },
      }),
      prisma.financialTransaction.count({ where: { paymentId } }),
      prisma.auditEvent.findMany({
        where: { tenantId, entityId: result.paymentAttemptId },
        orderBy: { occurredAt: 'asc' },
      }),
      prisma.domainEventOutbox.findMany({
        where: { tenantId, aggregateId: result.paymentAttemptId },
      }),
    ])
    expect(payment).toMatchObject({ state: 'CREATED', order: { paymentState: 'NOT_STARTED' } })
    expect(financialTransactions).toBe(0)
    expect(transitions.map(({ toState }) => toState)).toEqual([
      'CREATED',
      'INITIALIZATION_PENDING',
      'INITIALIZED',
      'CUSTOMER_ACTION_REQUIRED',
    ])
    expect(audits.map(({ action }) => action)).toEqual([
      'payment.execution_requested',
      'payment.attempt_initialization_started',
      'payment.attempt_initialized',
      'payment.customer_action_required',
    ])
    expect(outbox).toHaveLength(4)
    expect(JSON.stringify({ result, audits, outbox })).not.toContain('integration-secret')

    const invocations = adapterInvocations
    const replay = await service.initialize(
      tenantId,
      { type: 'CUSTOMER', id: customerId },
      { paymentId, idempotencyKey: key },
      new Date(now.getTime() + 2_000),
      randomUUID(),
    )
    expect(replay).toMatchObject({ paymentAttemptId: result.paymentAttemptId, replayed: true })
    expect(adapterInvocations).toBe(invocations)
    const duplicateReferenceKey = `execution-duplicate-reference-${randomUUID()}`
    adapterResult = {
      outcome: 'ACCEPTED',
      providerReference: result.providerReference!,
    }
    await expect(
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: duplicateReferenceKey },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_CONFLICT' })
    await expect(
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId: randomUUID(), idempotencyKey: key },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
  })

  it('fails closed for foreign customers, absent adapters, and unhealthy providers', async () => {
    await expect(
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: randomUUID() },
        { paymentId, idempotencyKey: `execution-foreign-${randomUUID()}` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' })
    await expect(
      service.initialize(
        randomUUID(),
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: `execution-cross-tenant-${randomUUID()}` },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' })

    const absentAdapter = executionService(createPaymentProviderAdapterRegistry([]))
    const absentKey = `execution-absent-${randomUUID()}`
    await expect(
      absentAdapter.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: absentKey },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE' })
    expect(
      await prisma.paymentAttempt.count({
        where: {
          tenantId,
          requestIdempotencyKey: paymentExecutionRequestKey(
            { type: 'CUSTOMER', id: customerId },
            absentKey,
          ),
        },
      }),
    ).toBe(0)

    await prisma.paymentProviderConfiguration.update({
      where: { id: configurationId },
      data: { healthStatus: 'UNHEALTHY' },
    })
    const unhealthyKey = `execution-unhealthy-${randomUUID()}`
    await expect(
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: unhealthyKey },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_MISSING' })
    expect(
      await prisma.paymentAttempt.count({
        where: {
          tenantId,
          requestIdempotencyKey: paymentExecutionRequestKey(
            { type: 'CUSTOMER', id: customerId },
            unhealthyKey,
          ),
        },
      }),
    ).toBe(0)
    await prisma.paymentProviderConfiguration.update({
      where: { id: configurationId },
      data: { healthStatus: 'HEALTHY' },
    })
  })

  it('persists redacted adapter and credential failures as terminal attempt history', async () => {
    const credentialFailureKey = `execution-credential-failure-${randomUUID()}`
    const credentialFailureService = createPrismaPaymentExecutionService(prisma, {
      adapterRegistry: createPaymentProviderAdapterRegistry([testAdapter()]),
      secretResolver: {
        testOnly: true,
        resolve: async () => {
          throw new Error('integration-secret must never escape')
        },
      },
      policy: testPolicy(),
    })
    const credentialFailure = await credentialFailureService.initialize(
      tenantId,
      { type: 'CUSTOMER', id: customerId },
      { paymentId, idempotencyKey: credentialFailureKey },
      now,
      randomUUID(),
    )
    expect(credentialFailure).toMatchObject({
      state: 'FAILED',
      outcome: 'RETRYABLE_FAILURE',
      failure: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: true },
    })

    const invalidKey = `execution-invalid-response-${randomUUID()}`
    adapterResult = {
      outcome: 'CUSTOMER_ACTION_REQUIRED',
      providerReference: 'provider-invalid',
      customerActionUrl: 'http://unsafe.example.test',
    }
    const invalid = await service.initialize(
      tenantId,
      { type: 'CUSTOMER', id: customerId },
      { paymentId, idempotencyKey: invalidKey },
      now,
      randomUUID(),
    )
    expect(invalid).toMatchObject({
      state: 'FAILED',
      outcome: 'UNKNOWN',
      failure: { code: 'PROVIDER_RESPONSE_INVALID', retryable: false },
    })
    const serialized = JSON.stringify(
      await prisma.auditEvent.findMany({
        where: {
          tenantId,
          entityId: { in: [credentialFailure.paymentAttemptId, invalid.paymentAttemptId] },
        },
      }),
    )
    expect(serialized).not.toContain('integration-secret')
    expect(serialized).not.toContain('http://unsafe.example.test')
  })

  it('normalizes provider rejection, retryable failure, and permanent failure without financial mutation', async () => {
    const cases = [
      ['REJECTED', 'PROVIDER_REJECTED', false],
      ['RETRYABLE_FAILURE', 'PROVIDER_TEMPORARY_FAILURE', true],
      ['PERMANENT_FAILURE', 'PROVIDER_PERMANENT_FAILURE', false],
    ] as const
    for (const [outcome, normalizedCode, retryable] of cases) {
      const key = `execution-${outcome.toLowerCase()}-${randomUUID()}`
      adapterResult = {
        outcome,
        normalizedCode,
        retryable,
        customerMessageKey: retryable ? 'payment.retry_later' : 'payment.initialization_rejected',
      }
      const result = await service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: key },
        now,
        randomUUID(),
      )
      expect(result).toMatchObject({
        state: 'FAILED',
        outcome,
        failure: { code: normalizedCode, retryable },
      })
    }
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true, financialTransaction: true },
    })
    expect(payment).toMatchObject({
      state: 'CREATED',
      financialTransaction: null,
      order: { paymentState: 'NOT_STARTED' },
    })
  })

  it('recovers a pending attempt after crashes at either transaction boundary', async () => {
    const preparationRollbackKey = `execution-preparation-rollback-${randomUUID()}`
    const rollbackPreparationService = createPrismaPaymentExecutionService(prisma, {
      adapterRegistry: createPaymentProviderAdapterRegistry([testAdapter()]),
      secretResolver: testSecretResolver(),
      policy: testPolicy(),
      beforePreparationCommit: async () => {
        throw new Error('injected transaction A rollback')
      },
    })
    await expect(
      rollbackPreparationService.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: preparationRollbackKey },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('transaction A rollback')
    expect(
      await prisma.paymentAttempt.count({
        where: {
          tenantId,
          requestIdempotencyKey: paymentExecutionRequestKey(
            { type: 'CUSTOMER', id: customerId },
            preparationRollbackKey,
          ),
        },
      }),
    ).toBe(0)

    const preparationKey = `execution-preparation-crash-${randomUUID()}`
    adapterResult = {
      outcome: 'ACCEPTED',
      providerReference: `provider-${randomUUID()}`,
    }
    let crashAfterPreparation = true
    const crashingPreparationService = createPrismaPaymentExecutionService(prisma, {
      adapterRegistry: createPaymentProviderAdapterRegistry([testAdapter()]),
      secretResolver: testSecretResolver(),
      policy: testPolicy(),
      afterPreparationCommit: async () => {
        if (crashAfterPreparation) {
          crashAfterPreparation = false
          throw new Error('injected crash after transaction A')
        }
      },
    })
    await expect(
      crashingPreparationService.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: preparationKey },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('injected crash')
    expect(
      await prisma.paymentAttempt.findFirstOrThrow({
        where: {
          tenantId,
          requestIdempotencyKey: paymentExecutionRequestKey(
            { type: 'CUSTOMER', id: customerId },
            preparationKey,
          ),
        },
      }),
    ).toMatchObject({ state: 'INITIALIZATION_PENDING', version: 2 })
    expect(
      await service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: preparationKey },
        new Date(now.getTime() + 1_000),
        randomUUID(),
      ),
    ).toMatchObject({ state: 'INITIALIZED', replayed: true })

    const resultCrashKey = `execution-result-crash-${randomUUID()}`
    adapterResult = {
      outcome: 'ACCEPTED',
      providerReference: `provider-${randomUUID()}`,
    }
    let failResultCommit = true
    const crashingResultService = createPrismaPaymentExecutionService(prisma, {
      adapterRegistry: createPaymentProviderAdapterRegistry([testAdapter()]),
      secretResolver: testSecretResolver(),
      policy: testPolicy(),
      beforeResultCommit: async () => {
        if (failResultCommit) {
          failResultCommit = false
          throw new Error('injected transaction B rollback')
        }
      },
    })
    await expect(
      crashingResultService.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: resultCrashKey },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('transaction B rollback')
    const pending = await prisma.paymentAttempt.findFirstOrThrow({
      where: {
        tenantId,
        requestIdempotencyKey: paymentExecutionRequestKey(
          { type: 'CUSTOMER', id: customerId },
          resultCrashKey,
        ),
      },
    })
    expect(pending).toMatchObject({ state: 'INITIALIZATION_PENDING', version: 2 })
    expect(
      await prisma.paymentAttemptStateTransition.count({
        where: { paymentAttemptId: pending.id },
      }),
    ).toBe(2)
    expect(await prisma.auditEvent.count({ where: { tenantId, entityId: pending.id } })).toBe(2)
    expect(
      await prisma.domainEventOutbox.count({ where: { tenantId, aggregateId: pending.id } }),
    ).toBe(2)
    expect(
      await service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: resultCrashKey },
        new Date(now.getTime() + 2_000),
        randomUUID(),
      ),
    ).toMatchObject({ state: 'INITIALIZED', replayed: true })
  })

  it('converges concurrent same-key execution and protects append-only results', async () => {
    const key = `execution-concurrent-${randomUUID()}`
    adapterResult = {
      outcome: 'ACCEPTED',
      providerReference: `provider-${randomUUID()}`,
    }
    const [first, second] = await Promise.all([
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: key },
        now,
        randomUUID(),
      ),
      service.initialize(
        tenantId,
        { type: 'CUSTOMER', id: customerId },
        { paymentId, idempotencyKey: key },
        now,
        randomUUID(),
      ),
    ])
    expect(first.paymentAttemptId).toBe(second.paymentAttemptId)
    expect(
      await prisma.paymentAttempt.count({
        where: {
          tenantId,
          requestIdempotencyKey: paymentExecutionRequestKey(
            { type: 'CUSTOMER', id: customerId },
            key,
          ),
        },
      }),
    ).toBe(1)
    await expect(
      prisma.paymentAttempt.update({
        where: { id: first.paymentAttemptId },
        data: { failureCode: 'TAMPERED_RESULT' },
      }),
    ).rejects.toThrow('immutable')
    const transition = await prisma.paymentAttemptStateTransition.findFirstOrThrow({
      where: { paymentAttemptId: first.paymentAttemptId },
    })
    await expect(
      prisma.paymentAttemptStateTransition.update({
        where: { id: transition.id },
        data: { providerOutcome: 'FAILED' },
      }),
    ).rejects.toThrow('append-only')
    await verifyAttemptForcedRls(first.paymentAttemptId)
  })

  it('rejects test credential resolvers in production before persistence', () => {
    expect(() =>
      createPrismaPaymentExecutionService(prisma, {
        adapterRegistry: createPaymentProviderAdapterRegistry([testAdapter()]),
        secretResolver: testSecretResolver(),
        policy: createProviderExecutionPolicy({
          environment: 'PRODUCTION',
          maxPersistenceAttempts: 3,
          invocationTimeoutMs: 10_000,
        }),
      }),
    ).toThrow('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE')
  })
})

function executionService(
  adapterRegistry: ReturnType<typeof createPaymentProviderAdapterRegistry>,
): PaymentExecutionService {
  return createPrismaPaymentExecutionService(prisma, {
    adapterRegistry,
    secretResolver: testSecretResolver(),
    policy: testPolicy(),
  })
}

function testPolicy() {
  return createProviderExecutionPolicy({
    environment: 'TEST',
    maxPersistenceAttempts: 5,
    invocationTimeoutMs: 10_000,
  })
}

function testAdapter(): PaymentProviderAdapter {
  return {
    code: providerCode,
    adapterVersion: '1.0.0',
    spiVersion: 1,
    capabilities: new Set(['PAYMENT_INITIALIZATION']),
    testOnly: true,
    mapProviderStatus: () => 'PENDING',
    initializePayment: async ({ amount, currency, credential }) => {
      adapterInvocations += 1
      expect(amount).toBe(530_000n)
      expect(currency).toBe('IRR')
      expect(new TextDecoder().decode(credential.material)).toBe('integration-secret')
      return adapterResult
    },
  }
}

function testSecretResolver() {
  return {
    testOnly: true as const,
    resolve: async (
      reference: string,
      requestedTenantId: string,
      requestedProviderCode: string,
    ) => {
      expect(reference).toBe(`vault://alo-noon/${tenantId}/${providerCode}`)
      expect(requestedTenantId).toBe(tenantId)
      expect(requestedProviderCode).toBe(providerCode)
      const material = new TextEncoder().encode('integration-secret')
      lastCredentialMaterial = material
      return {
        material,
        dispose: () => {
          disposedCredentials += 1
        },
      }
    },
  }
}

async function createFinancialOperator(suffix: string, occurredAt: Date): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: {
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '2').slice(0, 9)}`,
      verifiedAt: occurredAt,
    },
  })
  await prisma.tenantMembership.create({
    data: { tenantId, accountId: account.id, status: 'ACTIVE', activeAt: occurredAt },
  })
  const permission = await prisma.authorizationPermission.upsert({
    where: { code: 'payment-provider.configuration.govern' },
    update: {},
    create: {
      code: 'payment-provider.configuration.govern',
      description: 'Govern tenant payment provider configurations',
    },
  })
  const role = await prisma.authorizationRole.create({
    data: { code: `PAYMENT_EXECUTION_OPERATOR_${suffix}`, name: 'Payment execution operator' },
  })
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: occurredAt },
  })
  return account.id
}

async function createPayment(suffix: string, occurredAt: Date) {
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '3').slice(0, 9)}`,
      lifecycleStatus: 'ACTIVE',
    },
  })
  const city = await prisma.city.create({
    data: { tenantId, code: `EXEC-${suffix}`, nameFa: 'شهر اجرا', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: { tenantId, cityId: city.id, code: `EXEC-ZONE-${suffix}`, nameFa: 'منطقه اجرا' },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Execution Bakery ${suffix}`,
      displayNameFa: 'نانوایی اجرا',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `EXEC-BRANCH-${suffix}`,
      nameFa: 'شعبه اجرا',
      addressLine: 'نشانی تست اجرا',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: `execution-order-${suffix}`,
      customerId: customer.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      bakeryBranchId: branch.id,
      state: 'PENDING_CONFIRMATION',
      paymentState: 'NOT_STARTED',
      productionState: 'UNSCHEDULED',
      deliveryState: 'UNASSIGNED',
      recipientNameSnapshot: 'مشتری اجرا',
      recipientPhoneSnapshot: '+989111111111',
      deliveryAddressSnapshot: 'نشانی معتبر تست اجرا',
      deliveryLatitudeSnapshot: '36.5387',
      deliveryLongitudeSnapshot: '52.6765',
      bakeryNameSnapshot: 'نانوایی اجرا',
      subtotalAmount: 500_000n,
      deliveryFeeAmount: 30_000n,
      discountAmount: 0n,
      totalAmount: 530_000n,
      currency: 'IRR',
    },
  })
  return createPrismaPaymentLedgerService(prisma).initialize(
    tenantId,
    customer.id,
    { orderId: order.id, idempotencyKey: `execution-payment-${suffix}` },
    occurredAt,
    randomUUID(),
  )
}

async function verifyAttemptForcedRls(attemptId: string): Promise<void> {
  const roleName = `execution_rls_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "PaymentAttempt" TO "${roleName}"`)
  try {
    const hidden = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) count FROM "PaymentAttempt" WHERE "id" = ${attemptId}::uuid
      `
    })
    expect(hidden).toEqual([{ count: 0n }])
    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attemptId}::uuid
      `
    })
    expect(visible).toEqual([{ id: attemptId }])
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
  }
}
