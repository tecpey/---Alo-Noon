import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient, type Prisma } from '@alo-noon/database'
import {
  createAuthenticationDeliveryPolicy,
  createAuthenticationDeliveryRegistry,
  type AuthenticationDeliveryProvider,
} from '@alo-noon/domain'

import { createPrismaAuthenticationDeliveryService } from './modules/auth-delivery'
import { createPrismaAuthRepository } from './modules/auth'
import { buildApp } from './app'

const databaseDescribe = process.env['DATABASE_URL'] ? describe.sequential : describe.skip
const prisma = new PrismaClient()
const tenantId = randomUUID()
const otherTenantId = randomUUID()
const providerConfigurationId = randomUUID()
const now = new Date('2026-08-05T09:00:00.000Z')
let adapterCalls = 0
let credentialDisposals = 0
let adapterMode: 'DELIVERED' | 'TIMEOUT' = 'DELIVERED'

const adapter: AuthenticationDeliveryProvider = {
  code: 'TEST_SMS',
  adapterVersion: '1.0.0',
  spiVersion: 1,
  testOnly: true,
  async deliverOtp(request) {
    adapterCalls += 1
    expect(request.credential.material).toEqual(Uint8Array.from([1, 2, 3]))
    expect(request.otp).toMatch(/^\d{6}$/)
    if (adapterMode === 'TIMEOUT') return new Promise(() => undefined)
    return { outcome: 'DELIVERED', providerReference: `test-message-${request.deliveryAttemptId}` }
  },
}

afterAll(async () => prisma.$disconnect())

databaseDescribe('authentication delivery foundation on PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.tenant.createMany({
      data: [
        { id: tenantId, slug: `auth-delivery-${tenantId.slice(0, 8)}`, name: 'Auth delivery A' },
        {
          id: otherTenantId,
          slug: `auth-delivery-${otherTenantId.slice(0, 8)}`,
          name: 'Auth delivery B',
        },
      ],
    })
    await prisma.tenantDomain.create({
      data: {
        tenantId,
        host: `auth-${tenantId.slice(0, 8)}.alo-noon.test`,
        isPrimary: true,
        verifiedAt: now,
      },
    })
    await tenantTransaction(tenantId, (transaction) =>
      transaction.authDeliveryProviderConfiguration.create({
        data: {
          id: providerConfigurationId,
          tenantId,
          providerCode: adapter.code,
          adapterVersion: adapter.adapterVersion,
          adapterSpiVersion: adapter.spiVersion,
          environment: 'TEST',
          credentialReference: `env://AUTH_SMS_TEST_KEY_${tenantId.replaceAll('-', '').toUpperCase()}`,
          senderReference: 'test-sender',
          templateReference: 'test-otp-template',
          enabled: true,
          isDefault: true,
          priority: 100,
        },
      }),
    )
  })

  it('persists one digest-only delivery and replays the same idempotent request', async () => {
    adapterCalls = 0
    const service = deliveryService()
    const command = deliveryCommand('+989121234567', `otp-${randomUUID()}`, now)
    const first = await service.request(command)
    const replay = await service.request(command)

    expect(first.challengeId).toBe(replay.challengeId)
    expect(replay.replayed).toBe(true)
    expect(adapterCalls).toBe(1)
    expect(credentialDisposals).toBeGreaterThan(0)

    await tenantTransaction(tenantId, async (transaction) => {
      const challenge = await transaction.authOtpChallenge.findUniqueOrThrow({
        where: { id: first.challengeId },
        include: { deliveryAttempt: true },
      })
      expect(challenge.codeDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(challenge.codeDigest).not.toContain('123456')
      expect(challenge.status).toBe('DELIVERED')
      expect(challenge.deliveryAttempt?.state).toBe('DELIVERED')
      expect(challenge.deliveryAttempt?.providerReference).toContain('test-message-')
      const attemptId = challenge.deliveryAttempt?.id
      expect(attemptId).toBeTruthy()
      expect(await transaction.auditEvent.count({ where: { entityId: attemptId! } })).toBe(2)
      expect(
        await transaction.domainEventOutbox.count({
          where: { aggregateId: attemptId! },
        }),
      ).toBe(2)
    })
  })

  it('rejects conflicting idempotency reuse without another provider invocation', async () => {
    adapterCalls = 0
    const service = deliveryService()
    const idempotencyKey = `otp-${randomUUID()}`
    await service.request(deliveryCommand('+989121234568', idempotencyKey, now))
    await expect(
      service.request(deliveryCommand('+989121234569', idempotencyKey, now)),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    })
    expect(adapterCalls).toBe(1)
  })

  it('converges concurrent same-key requests on one challenge and one provider call', async () => {
    adapterCalls = 0
    const service = deliveryService()
    const command = deliveryCommand('+989121234570', `otp-${randomUUID()}`, now)
    const results = await Promise.all([service.request(command), service.request(command)])

    expect(new Set(results.map((result) => result.challengeId)).size).toBe(1)
    expect(adapterCalls).toBe(1)
  })

  it('recovers a crash after provider invocation as unknown without blind resend', async () => {
    adapterCalls = 0
    let failFinalization = true
    const service = deliveryService({
      beforeFinalizationCommit: async () => {
        if (failFinalization) throw new Error('injected finalization rollback')
      },
    })
    const command = deliveryCommand('+989121234571', `otp-${randomUUID()}`, now)
    await expect(service.request(command)).rejects.toThrow('injected finalization rollback')

    failFinalization = false
    const recovered = await service.request({
      ...command,
      now: new Date(now.getTime() + 1_001),
    })
    expect(recovered.replayed).toBe(true)
    expect(recovered.uncertain).toBe(true)
    expect(adapterCalls).toBe(1)
    await tenantTransaction(tenantId, async (transaction) => {
      const challenge = await transaction.authOtpChallenge.findUniqueOrThrow({
        where: { id: recovered.challengeId },
        include: { deliveryAttempt: true },
      })
      expect(challenge.status).toBe('DELIVERY_UNKNOWN')
      expect(challenge.deliveryAttempt?.state).toBe('UNKNOWN')
      expect(challenge.deliveryAttempt?.safeFailureCode).toBe('RECOVERY_OUTCOME_UNKNOWN')
    })
  })

  it('persists a provider timeout as unknown without retrying the external call', async () => {
    adapterCalls = 0
    adapterMode = 'TIMEOUT'
    try {
      const result = await deliveryService().request(
        deliveryCommand('+989121234574', `otp-${randomUUID()}`, now),
      )
      expect(result.uncertain).toBe(true)
      expect(adapterCalls).toBe(1)
      await tenantTransaction(tenantId, async (transaction) => {
        const challenge = await transaction.authOtpChallenge.findUniqueOrThrow({
          where: { id: result.challengeId },
          include: { deliveryAttempt: true },
        })
        expect(challenge.status).toBe('DELIVERY_UNKNOWN')
        expect(challenge.deliveryAttempt?.state).toBe('UNKNOWN')
        expect(challenge.deliveryAttempt?.safeFailureCode).toBe('PROVIDER_TIMEOUT_UNKNOWN')
      })
    } finally {
      adapterMode = 'DELIVERED'
    }
  })

  it('enforces forced RLS and append-only finalized delivery history', async () => {
    const service = deliveryService()
    const result = await service.request(
      deliveryCommand('+989121234572', `otp-${randomUUID()}`, now),
    )
    await verifyForcedRls(result.challengeId)

    await expect(
      tenantTransaction(
        tenantId,
        (transaction) =>
          transaction.$executeRaw`
          UPDATE "AuthOtpDeliveryAttempt"
          SET "safeFailureCode" = 'TAMPERED'
          WHERE "challengeId" = ${result.challengeId}::uuid
        `,
      ),
    ).rejects.toThrow()
  })

  it('atomically permits only one concurrent verification and session', async () => {
    const host = `auth-${tenantId.slice(0, 8)}.alo-noon.test`
    const app = await buildApp({
      auth: {
        repository: createPrismaAuthRepository(prisma),
        deliveryService: deliveryService(),
        otpPepper: 'integration-otp-pepper-that-is-long-enough',
        abusePepper: 'integration-abuse-pepper-that-is-long-enough',
        sessionPepper: 'integration-session-pepper-that-is-long-enough',
        secureCookie: false,
        now: () => now,
      },
    })
    try {
      const requested = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        headers: { host, 'idempotency-key': `otp-${randomUUID()}` },
        payload: { mobileE164: '+989121234573' },
      })
      expect(requested.statusCode).toBe(202)
      const challengeId = requested.json().data.challengeId as string
      const responses = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          headers: { host },
          payload: { challengeId, code: '123456' },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          headers: { host },
          payload: { challengeId, code: '123456' },
        }),
      ])
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401])
      await tenantTransaction(tenantId, async (transaction) => {
        expect(
          await transaction.authSession.count({
            where: { account: { is: { mobileE164: '+989121234573' } } },
          }),
        ).toBe(1)
      })
    } finally {
      await app.close()
    }
  })
})

function deliveryService(hooks: { beforeFinalizationCommit?: () => Promise<void> } = {}) {
  return createPrismaAuthenticationDeliveryService(prisma, {
    registry: createAuthenticationDeliveryRegistry([adapter]),
    credentialResolver: {
      testOnly: true,
      async resolve() {
        const material = Uint8Array.from([1, 2, 3])
        return {
          material,
          dispose() {
            material.fill(0)
            credentialDisposals += 1
          },
        }
      },
    },
    policy: createAuthenticationDeliveryPolicy({
      environment: 'TEST',
      otpTtlMs: 5 * 60_000,
      resendCooldownMs: 60_000,
      maxVerificationAttempts: 5,
      maxPhoneSendsPerHour: 5,
      maxIpSendsPerTenMinutes: 20,
      maxTenantSendsPerHour: 500,
      maxProviderSendsPerMinute: 300,
      circuitFailureThreshold: 5,
      circuitOpenMs: 5 * 60_000,
      invocationTimeoutMs: 500,
      maxPersistenceAttempts: 3,
    }),
    otpPepper: 'integration-otp-pepper-that-is-long-enough',
    abusePepper: 'integration-abuse-pepper-that-is-long-enough',
    generateOtp: () => '123456',
    ...hooks,
  })
}

function deliveryCommand(mobileE164: string, idempotencyKey: string, at: Date) {
  return {
    tenantId,
    mobileE164,
    idempotencyKey,
    sourceIp: '203.0.113.10',
    now: at,
    correlationId: randomUUID(),
  }
}

function tenantTransaction<T>(
  selectedTenantId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${selectedTenantId}, true)`
      return operation(transaction)
    },
    { isolationLevel: 'Serializable' },
  )
}

async function verifyForcedRls(challengeId: string): Promise<void> {
  const roleName = `auth_rls_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "AuthOtpChallenge" TO "${roleName}"`)
  try {
    const withoutContext = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) count FROM "AuthOtpChallenge" WHERE "id" = ${challengeId}::uuid
      `
    })
    expect(withoutContext).toEqual([{ count: 0n }])

    const crossTenant = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`
      return transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) count FROM "AuthOtpChallenge" WHERE "id" = ${challengeId}::uuid
      `
    })
    expect(crossTenant).toEqual([{ count: 0n }])

    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AuthOtpChallenge" WHERE "id" = ${challengeId}::uuid
      `
    })
    expect(visible).toEqual([{ id: challengeId }])
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
  }
}
