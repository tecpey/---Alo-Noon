import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { canonicalProviderRequest, type PaymentProviderAdapter } from '@alo-noon/domain'

import { createPrismaPaymentLedgerService } from './modules/payment-ledger'
import { createPrismaPaymentProviderService } from './modules/payment-provider'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantId = '00000000-0000-4000-8000-000000000001'

afterAll(async () => prisma.$disconnect())

databaseDescribe('payment provider PostgreSQL foundation', () => {
  it('governs configuration, attempts and replay-safe callbacks without capturing payment', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const now = new Date('2026-08-03T16:00:00.000Z')
    const actorId = await createFinancialOperator(suffix, now)
    const inactiveActorId = await createFinancialOperator(`${suffix}X`, now, 'SUSPENDED')
    const payment = await createPayment(suffix, now)
    const secret = 'integration-secret-must-never-persist'
    let disposed = false
    const adapter: PaymentProviderAdapter = {
      code: `TEST_GATEWAY_${suffix}`,
      capabilities: new Set(['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION']),
      testOnly: true,
      mapProviderStatus: () => 'PENDING',
      verifyCallback: async ({ credential, approvedHeaders }) => ({
        verified:
          new TextDecoder().decode(credential.material) === secret &&
          approvedHeaders['x-provider-event-id'] !== 'reject',
        normalizedOutcome:
          approvedHeaders['x-provider-event-id'] === 'reject' ? 'REJECTED' : 'VERIFIED',
        externalEventId: `callback-${suffix}`,
      }),
    }
    const service = createPrismaPaymentProviderService(prisma, {
      allowSystemOperations: true,
      adapters: new Map([[adapter.code, adapter]]),
      secretResolver: {
        resolve: async (reference, requestedTenant, providerCode) => {
          expect(reference).toBe(`vault://alo-noon/${tenantId}/${adapter.code}`)
          expect(requestedTenant).toBe(tenantId)
          expect(providerCode).toBe(adapter.code)
          return {
            material: new TextEncoder().encode(secret),
            dispose: () => {
              disposed = true
            },
          }
        },
      },
    })
    const credentialCommand = {
      actor: 'STAFF' as const,
      actorId,
      providerCode: adapter.code,
      reference: `vault://alo-noon/${tenantId}/${adapter.code}`,
      keyVersion: 'v1',
      metadata: { purpose: 'merchant-signing' },
      idempotencyKey: `provider-credential-${suffix}`,
    }
    await expect(
      service.createCredentialReference(
        tenantId,
        {
          ...credentialCommand,
          actorId: randomUUID(),
          idempotencyKey: `provider-credential-unauthorized-${suffix}`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_OPERATION_FORBIDDEN' })
    await expect(
      service.createCredentialReference(
        tenantId,
        {
          ...credentialCommand,
          actorId: inactiveActorId,
          idempotencyKey: `provider-credential-inactive-${suffix}`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_OPERATION_FORBIDDEN' })
    const credential = await service.createCredentialReference(
      tenantId,
      credentialCommand,
      now,
      randomUUID(),
    )
    expect(
      await service.createCredentialReference(tenantId, credentialCommand, now, randomUUID()),
    ).toEqual(credential)
    await expect(
      service.createCredentialReference(
        tenantId,
        { ...credentialCommand, keyVersion: 'different-version' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(credential).not.toHaveProperty('reference')

    const configurationCommand = {
      actor: 'STAFF' as const,
      actorId,
      providerCode: adapter.code,
      merchantReference: `merchant-${suffix}`,
      environment: 'TEST' as const,
      paymentContext: 'CHECKOUT' as const,
      currency: 'IRR' as const,
      callbackPolicy: 'SIGNED_ONLY' as const,
      capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'] as const,
      credentialReferenceId: credential.id,
      idempotencyKey: `provider-configuration-${suffix}`,
      reason: 'Provision test-only provider configuration',
    }
    const configuration = await service.createConfiguration(
      tenantId,
      configurationCommand,
      now,
      randomUUID(),
    )
    expect(configuration).toMatchObject({ isActive: false, isDefault: false, governanceVersion: 1 })
    expect(configuration).not.toHaveProperty('credentialReference')
    await expect(
      service.createConfiguration(
        tenantId,
        { ...configurationCommand, merchantReference: 'different-merchant' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await prisma.paymentProviderConfiguration.update({
      where: { id: configuration.id },
      data: { healthStatus: 'HEALTHY' },
    })
    const activated = await service.governConfiguration(
      tenantId,
      {
        actor: 'STAFF',
        actorId,
        providerConfigurationId: configuration.id,
        targetActive: true,
        makeDefault: true,
        idempotencyKey: `provider-activate-${suffix}`,
        reason: 'Enable reviewed test configuration',
      },
      new Date(now.getTime() + 1_000),
      randomUUID(),
    )
    expect(activated).toMatchObject({ isActive: true, isDefault: true, governanceVersion: 2 })
    await expect(
      service.governConfiguration(
        tenantId,
        {
          actor: 'STAFF',
          actorId,
          providerConfigurationId: configuration.id,
          targetActive: true,
          makeDefault: true,
          idempotencyKey: `provider-activate-${suffix}`,
          reason: 'Different replay reason',
        },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(
      await service.createConfiguration(
        tenantId,
        configurationCommand,
        new Date(now.getTime() + 1_100),
        randomUUID(),
      ),
    ).toMatchObject({ isActive: false, isDefault: false, governanceVersion: 1 })

    const alternateCode = `ALT_GATEWAY_${suffix}`
    const alternateCredential = await service.createCredentialReference(
      tenantId,
      {
        ...credentialCommand,
        providerCode: alternateCode,
        reference: `vault://alo-noon/${tenantId}/${alternateCode}`,
        idempotencyKey: `alternate-credential-${suffix}`,
      },
      now,
      randomUUID(),
    )
    const alternateConfiguration = await service.createConfiguration(
      tenantId,
      {
        ...configurationCommand,
        providerCode: alternateCode,
        credentialReferenceId: alternateCredential.id,
        idempotencyKey: `alternate-configuration-${suffix}`,
      },
      now,
      randomUUID(),
    )
    await expect(
      service.governConfiguration(
        tenantId,
        {
          actor: 'STAFF',
          actorId,
          providerConfigurationId: alternateConfiguration.id,
          targetActive: true,
          makeDefault: true,
          idempotencyKey: `alternate-default-${suffix}`,
          reason: 'Conflicting default must fail closed',
        },
        new Date(now.getTime() + 1_500),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_DEFAULT_CONFLICT' })

    await expect(
      prisma.paymentAttempt.create({
        data: {
          tenantId: randomUUID(),
          paymentId: payment.id,
          providerConfigurationId: configuration.id,
          requestIdempotencyKey: `cross-tenant-attempt-${suffix}`,
          requestFingerprint: 'a'.repeat(64),
          correlationId: randomUUID(),
        },
      }),
    ).rejects.toThrow()

    const rollbackKey = `provider-attempt-rollback-${suffix}`
    const failingService = createPrismaPaymentProviderService(prisma, {
      allowSystemOperations: true,
      beforeCommit: async () => {
        throw new Error('INJECTED_PROVIDER_ROLLBACK')
      },
    })
    await expect(
      failingService.createAttempt(
        tenantId,
        {
          paymentId: payment.id,
          environment: 'TEST',
          paymentContext: 'CHECKOUT',
          idempotencyKey: rollbackKey,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('INJECTED_PROVIDER_ROLLBACK')
    expect(
      await prisma.paymentAttempt.count({
        where: { tenantId, requestIdempotencyKey: rollbackKey },
      }),
    ).toBe(0)

    const attemptCommand = {
      paymentId: payment.id,
      environment: 'TEST' as const,
      paymentContext: 'CHECKOUT' as const,
      idempotencyKey: `provider-attempt-${suffix}`,
    }
    const attempt = await service.createAttempt(
      tenantId,
      attemptCommand,
      new Date(now.getTime() + 2_000),
      randomUUID(),
    )
    expect(await service.createAttempt(tenantId, attemptCommand, now, randomUUID())).toEqual(
      attempt,
    )
    await expect(
      service.createAttempt(
        tenantId,
        { ...attemptCommand, environment: 'PRODUCTION' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    const pendingCommand = {
      paymentAttemptId: attempt.id,
      to: 'INITIALIZATION_PENDING' as const,
      normalizedOutcome: 'PENDING' as const,
      idempotencyKey: `attempt-pending-${suffix}`,
    }
    await service.transitionAttempt(
      tenantId,
      pendingCommand,
      new Date(now.getTime() + 3_000),
      randomUUID(),
    )
    await expect(
      service.transitionAttempt(
        tenantId,
        { ...pendingCommand, normalizedOutcome: 'FAILED' },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    const initialized = await service.transitionAttempt(
      tenantId,
      {
        paymentAttemptId: attempt.id,
        to: 'INITIALIZED',
        normalizedOutcome: 'CUSTOMER_ACTION_REQUIRED',
        providerReference: `provider-reference-${suffix}`,
        idempotencyKey: `attempt-initialized-${suffix}`,
      },
      new Date(now.getTime() + 4_000),
      randomUUID(),
    )
    expect(initialized).toMatchObject({ state: 'INITIALIZED', version: 3 })
    const competingAttempt = await service.createAttempt(
      tenantId,
      { ...attemptCommand, idempotencyKey: `provider-attempt-competing-${suffix}` },
      new Date(now.getTime() + 4_100),
      randomUUID(),
    )
    await service.transitionAttempt(
      tenantId,
      {
        paymentAttemptId: competingAttempt.id,
        to: 'INITIALIZATION_PENDING',
        normalizedOutcome: 'PENDING',
        idempotencyKey: `attempt-competing-pending-${suffix}`,
      },
      new Date(now.getTime() + 4_200),
      randomUUID(),
    )
    await expect(
      service.transitionAttempt(
        tenantId,
        {
          paymentAttemptId: competingAttempt.id,
          to: 'INITIALIZED',
          normalizedOutcome: 'CUSTOMER_ACTION_REQUIRED',
          providerReference: `provider-reference-${suffix}`,
          idempotencyKey: `attempt-competing-initialized-${suffix}`,
        },
        new Date(now.getTime() + 4_300),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_CONFLICT' })
    expect(
      await service.transitionAttempt(tenantId, pendingCommand, now, randomUUID()),
    ).toMatchObject({ state: 'INITIALIZATION_PENDING', version: 2, providerReference: null })
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.paymentAttempt.update({
          where: { id: attempt.id },
          data: { state: 'FAILED', version: 9 },
        })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }),
    ).rejects.toThrow('contiguous transition history')
    await expect(
      service.transitionAttempt(
        tenantId,
        {
          paymentAttemptId: attempt.id,
          to: 'VERIFIED',
          idempotencyKey: `attempt-skip-${suffix}`,
        },
        now,
        randomUUID(),
      ),
    ).rejects.toThrow('not allowed')

    const callbackPayload = {
      authority: `provider-reference-${suffix}`,
      authorization: secret,
    }
    const callbackCommand = {
      providerCode: adapter.code,
      environment: 'TEST' as const,
      externalEventId: `callback-${suffix}`,
      approvedHeaders: { 'x-provider-timestamp': '1722700800' },
      canonicalPayload: callbackPayload,
      idempotencyKey: `callback-receive-${suffix}`,
    }
    const [receipt, duplicate] = await Promise.all([
      service.receiveCallback(
        tenantId,
        callbackCommand,
        new Date(now.getTime() + 5_000),
        randomUUID(),
      ),
      service.receiveCallback(
        tenantId,
        { ...callbackCommand, idempotencyKey: `callback-receive-duplicate-${suffix}` },
        new Date(now.getTime() + 5_000),
        randomUUID(),
      ),
    ])
    expect(duplicate).toEqual(receipt)
    expect(receipt).toMatchObject({
      verificationStatus: 'UNVERIFIED',
      processingStatus: 'RECEIVED',
    })
    await expect(
      service.receiveCallback(
        tenantId,
        { ...callbackCommand, canonicalPayload: { authority: 'different' } },
        now,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CALLBACK_REPLAY_CONFLICT' })

    const verified = await service.verifyCallback(
      tenantId,
      {
        callbackReceiptId: receipt.id,
        idempotencyKey: `callback-process-${suffix}`,
        canonicalBody: new TextEncoder().encode(canonicalProviderRequest(callbackPayload)),
        approvedHeaders: callbackCommand.approvedHeaders,
      },
      new Date(now.getTime() + 6_000),
      randomUUID(),
    )
    expect(verified).toMatchObject({
      verificationStatus: 'VERIFIED',
      processingStatus: 'PROCESSED',
    })
    expect(disposed).toBe(true)
    const rejectedPayload = { authority: `rejected-reference-${suffix}` }
    const rejectedHeaders = {
      'x-provider-event-id': 'reject',
      'x-provider-timestamp': '1722700801',
    }
    const rejectedReceipt = await service.receiveCallback(
      tenantId,
      {
        ...callbackCommand,
        externalEventId: `callback-rejected-${suffix}`,
        approvedHeaders: rejectedHeaders,
        canonicalPayload: rejectedPayload,
        idempotencyKey: `callback-rejected-receive-${suffix}`,
      },
      new Date(now.getTime() + 7_000),
      randomUUID(),
    )
    expect(
      await service.verifyCallback(
        tenantId,
        {
          callbackReceiptId: rejectedReceipt.id,
          idempotencyKey: `callback-rejected-process-${suffix}`,
          canonicalBody: new TextEncoder().encode(canonicalProviderRequest(rejectedPayload)),
          approvedHeaders: rejectedHeaders,
        },
        new Date(now.getTime() + 8_000),
        randomUUID(),
      ),
    ).toMatchObject({ verificationStatus: 'REJECTED', processingStatus: 'REJECTED' })
    const resolverFailurePayload = { authority: `resolver-failure-${suffix}` }
    const resolverFailureReceipt = await service.receiveCallback(
      tenantId,
      {
        ...callbackCommand,
        externalEventId: `callback-resolver-failure-${suffix}`,
        canonicalPayload: resolverFailurePayload,
        idempotencyKey: `callback-resolver-failure-receive-${suffix}`,
      },
      new Date(now.getTime() + 9_000),
      randomUUID(),
    )
    const failingResolverService = createPrismaPaymentProviderService(prisma, {
      allowSystemOperations: true,
      adapters: new Map([[adapter.code, adapter]]),
      secretResolver: {
        resolve: async () => {
          throw new Error(secret)
        },
      },
    })
    const resolverFailure = await failingResolverService
      .verifyCallback(
        tenantId,
        {
          callbackReceiptId: resolverFailureReceipt.id,
          idempotencyKey: `callback-resolver-failure-process-${suffix}`,
          canonicalBody: new TextEncoder().encode(canonicalProviderRequest(resolverFailurePayload)),
          approvedHeaders: callbackCommand.approvedHeaders,
        },
        new Date(now.getTime() + 10_000),
        randomUUID(),
      )
      .catch((error: unknown) => error)
    expect(resolverFailure).toMatchObject({ code: 'PROVIDER_CREDENTIAL_RESOLUTION_FAILED' })
    expect(String(resolverFailure)).not.toContain(secret)
    expect(
      await prisma.paymentCallbackReceipt.findUniqueOrThrow({
        where: { id: resolverFailureReceipt.id },
      }),
    ).toMatchObject({ verificationStatus: 'UNVERIFIED', processingStatus: 'RECEIVED' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).state).toBe(
      'CREATED',
    )
    expect(await prisma.financialTransaction.count({ where: { paymentId: payment.id } })).toBe(0)
    const serialized = JSON.stringify({
      receipts: await prisma.paymentCallbackReceipt.findMany({ where: { tenantId } }),
      audits: await prisma.auditEvent.findMany({
        where: {
          tenantId,
          OR: [
            { action: { startsWith: 'payment.' } },
            { action: { startsWith: 'payment_provider.' } },
          ],
        },
      }),
      outbox: await prisma.domainEventOutbox.findMany({
        where: {
          tenantId,
          OR: [{ name: { startsWith: 'payment.' } }, { name: { startsWith: 'payment_provider.' } }],
        },
      }),
    })
    expect(serialized).not.toContain(secret)

    await expect(
      prisma.paymentAttemptStateTransition.update({
        where: {
          id: (
            await prisma.paymentAttemptStateTransition.findFirstOrThrow({
              where: { paymentAttemptId: attempt.id },
            })
          ).id,
        },
        data: { providerOutcome: 'FAILED' },
      }),
    ).rejects.toThrow('append-only')
    await expect(
      prisma.providerCredentialReference.update({
        where: { id: credential.id },
        data: { keyVersion: 'v2' },
      }),
    ).rejects.toThrow('immutable')
    await verifyForcedRls(suffix, configuration.id)
  })
})

async function createFinancialOperator(
  suffix: string,
  now: Date,
  membershipStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
): Promise<string> {
  const account = await prisma.identityAccount.create({
    data: {
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '2').slice(0, 9)}`,
      verifiedAt: now,
    },
  })
  await prisma.tenantMembership.create({
    data: {
      tenantId,
      accountId: account.id,
      status: membershipStatus,
      activeAt: membershipStatus === 'ACTIVE' ? now : null,
      suspendedAt: membershipStatus === 'SUSPENDED' ? now : null,
    },
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
    data: { code: `PAYMENT_PROVIDER_OPERATOR_${suffix}`, name: 'Payment provider operator' },
  })
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })
  return account.id
}

async function createPayment(suffix: string, now: Date) {
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '3').slice(0, 9)}`,
      lifecycleStatus: 'ACTIVE',
    },
  })
  const city = await prisma.city.create({
    data: { tenantId, code: `PROVIDER-${suffix}`, nameFa: 'شهر ارائه‌دهنده', isActive: true },
  })
  const zone = await prisma.operationalZone.create({
    data: {
      tenantId,
      cityId: city.id,
      code: `PROVIDER-ZONE-${suffix}`,
      nameFa: 'منطقه ارائه‌دهنده',
    },
  })
  const bakery = await prisma.bakery.create({
    data: {
      tenantId,
      legalName: `Provider Bakery ${suffix}`,
      displayNameFa: 'نانوایی ارائه‌دهنده',
      partnerStatus: 'ACTIVE',
    },
  })
  const branch = await prisma.bakeryBranch.create({
    data: {
      tenantId,
      bakeryId: bakery.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      code: `PROVIDER-BRANCH-${suffix}`,
      nameFa: 'شعبه ارائه‌دهنده',
      addressLine: 'نشانی تست ارائه‌دهنده',
      latitude: '36.5442',
      longitude: '52.6781',
      operationalStatus: 'ACTIVE',
      qualityStatus: 'APPROVED',
    },
  })
  const order = await prisma.order.create({
    data: {
      tenantId,
      idempotencyKey: `provider-order-${suffix}`,
      customerId: customer.id,
      cityId: city.id,
      operationalZoneId: zone.id,
      bakeryBranchId: branch.id,
      state: 'PENDING_CONFIRMATION',
      paymentState: 'NOT_STARTED',
      productionState: 'UNSCHEDULED',
      deliveryState: 'UNASSIGNED',
      recipientNameSnapshot: 'مشتری ارائه‌دهنده',
      recipientPhoneSnapshot: '+989111111111',
      deliveryAddressSnapshot: 'نشانی معتبر تست ارائه‌دهنده',
      deliveryLatitudeSnapshot: '36.5387',
      deliveryLongitudeSnapshot: '52.6765',
      bakeryNameSnapshot: 'نانوایی ارائه‌دهنده',
      subtotalAmount: 500_000n,
      deliveryFeeAmount: 30_000n,
      discountAmount: 0n,
      totalAmount: 530_000n,
      currency: 'IRR',
    },
  })
  const service = createPrismaPaymentLedgerService(prisma)
  return service.initialize(
    tenantId,
    customer.id,
    { orderId: order.id, idempotencyKey: `provider-payment-${suffix}` },
    now,
    randomUUID(),
  )
}

async function verifyForcedRls(suffix: string, configurationId: string) {
  const roleName = `provider_rls_${suffix.toLowerCase()}`
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
  for (const table of [
    'ProviderCredentialReference',
    'PaymentProviderConfiguration',
    'PaymentProviderGovernanceEvent',
    'PaymentAttempt',
    'PaymentAttemptStateTransition',
    'PaymentCallbackReceipt',
  ]) {
    await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "${table}" TO "${roleName}"`)
  }
  try {
    const hidden = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*) count FROM "PaymentProviderConfiguration"`
    })
    expect(hidden).toEqual([{ count: 0n }])
    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return transaction.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "PaymentProviderConfiguration" WHERE "id" = ${configurationId}::uuid`
    })
    expect(visible).toEqual([{ id: configurationId }])
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
  }
}
