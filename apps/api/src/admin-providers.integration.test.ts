import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'
import { createPaymentProviderAdapterRegistry, type PaymentProviderAdapter } from '@alo-noon/domain'

import { buildApp } from './app'
import { createPrismaAuthDeliveryProviderService } from './modules/auth-delivery-provider'
import { authenticationSessionDigest } from './modules/auth-delivery'
import { createPrismaAuthRepository } from './modules/auth'
import { createPrismaPaymentProviderService } from './modules/payment-provider'

/**
 * Drives the admin routes end to end against PostgreSQL. The point is what unit
 * tests cannot reach: the services re-check authorization inside their own write
 * transaction against live grant rows, so a session whose grant was revoked must
 * be refused even though the session object still carries the grant.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const sessionPepper = 'admin-integration-session-pepper'

afterAll(async () => prisma.$disconnect())

interface Fixture {
  tenantId: string
  host: string
}

databaseDescribe('admin provider governance over PostgreSQL', () => {
  it('lets a governing operator provision a gateway, and stops one whose grant is revoked', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const fixture = await createTenant(suffix)
    const now = new Date()
    const providerCode = `ADMIN_GATEWAY_${suffix}`
    const adapter: PaymentProviderAdapter = {
      code: providerCode,
      adapterVersion: '1.0.0',
      spiVersion: 1,
      capabilities: new Set(['PAYMENT_INITIALIZATION']),
      testOnly: true,
      mapProviderStatus: () => 'PENDING',
      initializePayment: async () => ({ outcome: 'ACCEPTED', providerReference: 'unused' }),
    }

    const governor = await createOperator(fixture, `G${suffix}`, now, [
      'payment-provider.configuration.govern',
      'auth-delivery-provider.configuration.govern',
    ])
    const outsider = await createOperator(fixture, `O${suffix}`, now, ['session.self.read'])

    const app = await buildApp({
      auth: authDependencies(),
      adminProviders: {
        paymentProviderService: createPrismaPaymentProviderService(prisma, {
          adapterRegistry: createPaymentProviderAdapterRegistry([adapter]),
        }),
        authDeliveryProviderService: createPrismaAuthDeliveryProviderService(prisma),
      },
    })

    try {
      const asGovernor = { host: fixture.host, authorization: `Bearer ${governor.token}` }

      const credential = await app.inject({
        method: 'POST',
        headers: asGovernor,
        url: '/api/v1/admin/payment-providers/credentials',
        payload: {
          providerCode,
          reference: `vault://alo-noon/${fixture.tenantId}/${providerCode}`,
          keyVersion: 'v1',
          metadata: {},
          idempotencyKey: `admin-credential-${suffix}`,
        },
      })
      expect(credential.statusCode).toBe(201)

      const configuration = await app.inject({
        method: 'POST',
        headers: asGovernor,
        url: '/api/v1/admin/payment-providers/configurations',
        payload: {
          providerCode,
          adapterVersion: '1.0.0',
          adapterSpiVersion: 1,
          merchantReference: `merchant-${suffix}`,
          environment: 'TEST',
          paymentContext: 'CHECKOUT',
          currency: 'IRR',
          callbackPolicy: 'SIGNED_ONLY',
          capabilities: ['PAYMENT_INITIALIZATION'],
          credentialReferenceId: credential.json().data.id,
          idempotencyKey: `admin-configuration-${suffix}`,
          reason: 'Integration provisioning',
        },
      })
      expect(configuration.statusCode).toBe(201)
      const configurationId = configuration.json().data.id as string
      // A newly created gateway is not usable yet.
      expect(configuration.json().data.isActive).toBe(false)
      expect(configuration.json().data.healthStatus).toBe('UNKNOWN')

      const governed = await app.inject({
        method: 'POST',
        headers: asGovernor,
        url: `/api/v1/admin/payment-providers/configurations/${configurationId}/governance`,
        payload: {
          targetActive: true,
          makeDefault: true,
          idempotencyKey: `admin-governance-${suffix}`,
          reason: 'Integration provisioning',
        },
      })
      expect(governed.statusCode).toBe(200)
      expect(governed.json().data.isActive).toBe(true)
      expect(governed.json().data.isDefault).toBe(true)

      const attested = await app.inject({
        method: 'POST',
        headers: asGovernor,
        url: `/api/v1/admin/payment-providers/configurations/${configurationId}/health`,
        payload: { healthStatus: 'HEALTHY', reason: 'Integration provisioning' },
      })
      expect(attested.statusCode).toBe(200)
      expect(attested.json().data.healthStatus).toBe('HEALTHY')

      const listed = await app.inject({
        method: 'GET',
        headers: asGovernor,
        url: '/api/v1/admin/payment-providers/configurations',
      })
      expect(listed.statusCode).toBe(200)
      expect(listed.json().data.some((entry: { id: string }) => entry.id === configurationId)).toBe(
        true,
      )
      // The reference string stays in the database; only its id is published.
      expect(listed.body).not.toContain('vault://alo-noon/')

      // Every mutation left an audit trail attributed to the acting account.
      const audits = await prisma.auditEvent.findMany({
        where: { tenantId: fixture.tenantId, actorId: governor.accountId },
      })
      expect(audits.length).toBeGreaterThanOrEqual(3)
      expect(audits.every((event) => event.actorType === 'STAFF')).toBe(true)

      // An account with a valid session but no governance grant is refused.
      const refused = await app.inject({
        method: 'GET',
        headers: { host: fixture.host, authorization: `Bearer ${outsider.token}` },
        url: '/api/v1/admin/payment-providers/configurations',
      })
      expect(refused.statusCode).toBe(403)

      // Revoking the grant takes effect against the still-valid session.
      await prisma.accessGrant.updateMany({
        where: { accountId: governor.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      const afterRevocation = await app.inject({
        method: 'POST',
        headers: asGovernor,
        url: `/api/v1/admin/payment-providers/configurations/${configurationId}/health`,
        payload: { healthStatus: 'DEGRADED', reason: 'Should never be recorded' },
      })
      expect(afterRevocation.statusCode).toBe(403)
      const unchanged = await prisma.paymentProviderConfiguration.findFirst({
        where: { id: configurationId },
      })
      expect(unchanged?.healthStatus).toBe('HEALTHY')
    } finally {
      await app.close()
    }
  })

  it('configures an SMS provider and takes it out of rotation', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase()
    const fixture = await createTenant(suffix)
    const now = new Date()
    const governor = await createOperator(fixture, `S${suffix}`, now, [
      'auth-delivery-provider.configuration.govern',
    ])
    const app = await buildApp({
      auth: authDependencies(),
      adminProviders: {
        paymentProviderService: createPrismaPaymentProviderService(prisma),
        authDeliveryProviderService: createPrismaAuthDeliveryProviderService(prisma),
      },
    })

    try {
      const headers = { host: fixture.host, authorization: `Bearer ${governor.token}` }
      const created = await app.inject({
        method: 'POST',
        headers,
        url: '/api/v1/admin/sms-providers/configurations',
        payload: {
          providerCode: `ADMIN_SMS_${suffix}`,
          adapterVersion: '1.0.0',
          environment: 'TEST',
          credentialReference: `env://AUTH_SMS_${suffix}_API_KEY`,
          senderReference: '3000',
          templateReference: 'otp-fa',
          enabled: true,
          isDefault: true,
          reason: 'Integration provisioning',
        },
      })
      expect(created.statusCode).toBe(201)
      const configurationId = created.json().data.id as string

      const withdrawn = await app.inject({
        method: 'POST',
        headers,
        url: `/api/v1/admin/sms-providers/configurations/${configurationId}/health`,
        payload: { healthStatus: 'UNHEALTHY', reason: 'Integration rotation check' },
      })
      expect(withdrawn.statusCode).toBe(200)
      expect(withdrawn.json().data.healthStatus).toBe('UNHEALTHY')

      const listed = await app.inject({
        method: 'GET',
        headers,
        url: '/api/v1/admin/sms-providers/configurations',
      })
      expect(listed.statusCode).toBe(200)
      // The credential reference is not part of the published summary.
      expect(listed.body).not.toContain('AUTH_SMS_')
    } finally {
      await app.close()
    }
  })
})

function authDependencies() {
  return {
    repository: createPrismaAuthRepository(prisma),
    deliveryService: { request: async () => Promise.reject(new Error('unused')) },
    otpPepper: 'admin-integration-otp-pepper',
    abusePepper: 'admin-integration-abuse-pepper',
    sessionPepper,
    secureCookie: false,
  }
}

async function createTenant(suffix: string): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `admin-providers-${suffix.toLowerCase()}`, name: `Admin providers ${suffix}` },
  })
  const host = `admin-${suffix.toLowerCase()}.alo-noon.test`
  await prisma.tenantDomain.create({
    data: { tenantId: tenant.id, host, isPrimary: true, verifiedAt: new Date() },
  })
  return { tenantId: tenant.id, host }
}

async function createOperator(
  fixture: Fixture,
  suffix: string,
  now: Date,
  permissions: readonly string[],
): Promise<{ accountId: string; token: string }> {
  const account = await prisma.identityAccount.create({
    data: {
      mobileE164: `+989${randomUUID().replace(/\D/g, '').padEnd(9, '3').slice(0, 9)}`,
      verifiedAt: now,
    },
  })
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${fixture.tenantId}, true)`
    await transaction.tenantMembership.create({
      data: { tenantId: fixture.tenantId, accountId: account.id, status: 'ACTIVE', activeAt: now },
    })
  })

  const role = await prisma.authorizationRole.create({
    data: { code: `ADMIN_GOVERNOR_${suffix}`, name: 'Admin governor' },
  })
  for (const code of permissions) {
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description: `Integration permission ${code}` },
    })
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
  }
  await prisma.accessGrant.create({
    data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
  })

  const token = randomUUID()
  await prisma.authSession.create({
    data: {
      accountId: account.id,
      activeTenantId: fixture.tenantId,
      tokenDigest: authenticationSessionDigest(sessionPepper, token),
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      lastSeenAt: now,
    },
  })
  return { accountId: account.id, token }
}
