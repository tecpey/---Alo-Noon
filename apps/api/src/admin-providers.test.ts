import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccessGrantContract, SessionContext } from '@alo-noon/contracts'

import { buildApp } from './app'
import type { AuthDeliveryProviderService } from './modules/auth-delivery-provider'
import { AuthDeliveryProviderError } from './modules/auth-delivery-provider'
import type { AuthDependencies, AuthRepository } from './modules/auth'
import type { PaymentProviderService } from './modules/payment-provider'
import { PaymentProviderError } from './modules/payment-provider'

const tenantId = '00000000-0000-4000-8000-000000000001'
const accountId = '00000000-0000-4000-8000-0000000000a1'
const configurationId = '00000000-0000-4000-8000-0000000000c1'
const credentialReferenceId = '00000000-0000-4000-8000-0000000000d1'
const PAYMENT_PERMISSION = 'payment-provider.configuration.govern'
const DELIVERY_PERMISSION = 'auth-delivery-provider.configuration.govern'

function grant(permissions: string[], scopeType = 'GLOBAL', scopeId: string | null = null) {
  return {
    grantId: '00000000-0000-4000-8000-0000000000e1',
    roleCode: 'PROVIDER_GOVERNOR',
    permissions,
    scopeType,
    scopeId,
    expiresAt: null,
  } as unknown as AccessGrantContract
}

function authFixture(grants: AccessGrantContract[] | null): AuthDependencies {
  const session: SessionContext | null = grants
    ? ({
        tenantId,
        accountId,
        customerId: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        grants,
      } as unknown as SessionContext)
    : null
  return {
    repository: {
      resolveTenantByHost: async () => tenantId,
      findSession: async () => session,
    } as unknown as AuthRepository,
    deliveryService: { request: async () => Promise.reject(new Error('unused')) },
    otpPepper: 'admin-otp-pepper',
    abusePepper: 'admin-abuse-pepper',
    sessionPepper: 'admin-session-pepper',
    secureCookie: false,
  }
}

const configurationSummary = {
  id: configurationId,
  providerCode: 'DEMOPAY',
  adapterVersion: '1.0.0',
  adapterSpiVersion: 1,
  merchantReference: 'merchant-1',
  environment: 'TEST',
  paymentContext: 'CHECKOUT',
  currency: 'IRR',
  callbackPolicy: 'SIGNED_ONLY',
  capabilities: ['PAYMENT_INITIALIZATION'],
  credentialReferenceId,
  isActive: false,
  isDefault: false,
  healthStatus: 'UNKNOWN',
  governanceVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const deliverySummary = {
  id: configurationId,
  providerCode: 'DEMOSMS',
  adapterVersion: '1.0.0',
  adapterSpiVersion: 1,
  environment: 'TEST',
  senderReference: '3000',
  templateReference: 'otp-fa',
  enabled: true,
  isDefault: true,
  priority: 100,
  healthStatus: 'UNKNOWN',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function serviceFixtures() {
  const paymentProviderService = {
    createCredentialReference: vi.fn().mockResolvedValue({
      id: credentialReferenceId,
      providerCode: 'DEMOPAY',
      keyVersion: 'v1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    createConfiguration: vi.fn().mockResolvedValue(configurationSummary),
    governConfiguration: vi
      .fn()
      .mockResolvedValue({ ...configurationSummary, isActive: true, isDefault: true }),
    setConfigurationHealth: vi
      .fn()
      .mockResolvedValue({ ...configurationSummary, healthStatus: 'HEALTHY' }),
    listConfigurations: vi.fn().mockResolvedValue([configurationSummary]),
  }
  const authDeliveryProviderService = {
    createConfiguration: vi.fn().mockResolvedValue(deliverySummary),
    setConfigurationHealth: vi
      .fn()
      .mockResolvedValue({ ...deliverySummary, healthStatus: 'HEALTHY' }),
    listConfigurations: vi.fn().mockResolvedValue([deliverySummary]),
  }
  return { paymentProviderService, authDeliveryProviderService }
}

// The repository fixture decides what the token resolves to, so any non-empty
// bearer value is enough to exercise the route's own authorization.
const staffHeaders = { authorization: 'Bearer admin-staff-session-token' }

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

async function adminApp(options: {
  grants?: AccessGrantContract[] | null
  services?: ReturnType<typeof serviceFixtures>
}) {
  const services = options.services ?? serviceFixtures()
  const app = await buildApp({
    auth: authFixture(
      options.grants === undefined ? [grant([PAYMENT_PERMISSION])] : options.grants,
    ),
    adminProviders: {
      paymentProviderService: services.paymentProviderService as unknown as PaymentProviderService,
      authDeliveryProviderService:
        services.authDeliveryProviderService as unknown as AuthDeliveryProviderService,
    },
  })
  apps.push(app)
  return { app, services }
}

const credentialCommand = {
  providerCode: 'DEMOPAY',
  reference: 'local-encrypted://DEMOPAY',
  keyVersion: 'v1',
  metadata: {},
  idempotencyKey: 'admin-credential-key-0001',
}

const configurationCommand = {
  providerCode: 'DEMOPAY',
  adapterVersion: '1.0.0',
  adapterSpiVersion: 1,
  merchantReference: 'merchant-1',
  environment: 'TEST',
  paymentContext: 'CHECKOUT',
  currency: 'IRR',
  callbackPolicy: 'SIGNED_ONLY',
  capabilities: ['PAYMENT_INITIALIZATION'],
  credentialReferenceId,
  idempotencyKey: 'admin-configuration-key-0001',
  reason: 'Soft launch provisioning',
}

const smsCommand = {
  providerCode: 'DEMOSMS',
  adapterVersion: '1.0.0',
  environment: 'TEST',
  credentialReference: 'env://AUTH_SMS_DEMOSMS_API_KEY',
  senderReference: '3000',
  templateReference: 'otp-fa',
  enabled: true,
  isDefault: true,
  reason: 'Soft launch provisioning',
}

describe('admin provider governance routes', () => {
  it('registers a credential by reference and attributes it to the acting account', async () => {
    const { app, services } = await adminApp({})

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/credentials',
      payload: credentialCommand,
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().data.id).toBe(credentialReferenceId)
    const [calledTenantId, command] = services.paymentProviderService.createCredentialReference.mock
      .calls[0] as [string, { actor: string; actorId: string; reference: string }]
    // Tenant and actor come from the session, never from the request body.
    expect(calledTenantId).toBe(tenantId)
    expect(command.actor).toBe('STAFF')
    expect(command.actorId).toBe(accountId)
    expect(command.reference).toBe('local-encrypted://DEMOPAY')
  })

  it('creates, governs, and attests a payment gateway configuration', async () => {
    const { app, services } = await adminApp({})

    const created = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
      payload: configurationCommand,
    })
    expect(created.statusCode).toBe(201)
    // A new gateway is not usable yet: inactive and health UNKNOWN.
    expect(created.json().data.isActive).toBe(false)
    expect(created.json().data.healthStatus).toBe('UNKNOWN')

    const governed = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: `/api/v1/admin/payment-providers/configurations/${configurationId}/governance`,
      payload: {
        targetActive: true,
        makeDefault: true,
        idempotencyKey: 'admin-governance-key-0001',
        reason: 'Activate for soft launch',
      },
    })
    expect(governed.statusCode).toBe(200)
    expect(governed.json().data.isDefault).toBe(true)

    const attested = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: `/api/v1/admin/payment-providers/configurations/${configurationId}/health`,
      payload: { healthStatus: 'HEALTHY', reason: 'Verified a live test transaction' },
    })
    expect(attested.statusCode).toBe(200)
    expect(attested.json().data.healthStatus).toBe('HEALTHY')

    const [, healthCommand] = services.paymentProviderService.setConfigurationHealth.mock
      .calls[0] as [string, { providerConfigurationId: string; reason: string }]
    expect(healthCommand.providerConfigurationId).toBe(configurationId)
    expect(healthCommand.reason).toBe('Verified a live test transaction')
  })

  it('lists configurations without exposing any credential reference or material', async () => {
    const { app } = await adminApp({})

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toHaveLength(1)
    // Only the reference *id* — never the reference string, never the secret.
    expect(response.body).not.toMatch(/local-encrypted|vault:|aws-sm|PAYMENT_SECRET/)
  })

  it('rejects an unauthenticated caller before reaching any service', async () => {
    const { app, services } = await adminApp({ grants: null })

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(401)
    expect(services.paymentProviderService.listConfigurations).not.toHaveBeenCalled()
  })

  it.each([
    ['no governance permission', [grant(['session.self.read'])]],
    ['a city-scoped governance grant', [grant([PAYMENT_PERMISSION], 'CITY', tenantId)]],
    ['only the SMS governance permission', [grant([DELIVERY_PERMISSION])]],
  ])('rejects a session holding %s', async (_label, grants) => {
    const { app, services } = await adminApp({ grants })

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('PROVIDER_GOVERNANCE_FORBIDDEN')
    expect(services.paymentProviderService.listConfigurations).not.toHaveBeenCalled()
  })

  it('rejects a malformed command without calling the service', async () => {
    const { app, services } = await adminApp({})

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/credentials',
      // env:// is not an accepted payment credential scheme, and the database
      // CHECK constraint would refuse it too.
      payload: { ...credentialCommand, reference: 'env://DEMOPAY_API_KEY' },
    })

    expect(response.statusCode).toBe(400)
    expect(services.paymentProviderService.createCredentialReference).not.toHaveBeenCalled()
  })

  it('rejects unknown fields rather than silently dropping them', async () => {
    const { app } = await adminApp({})

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/credentials',
      payload: { ...credentialCommand, tenantId: '00000000-0000-4000-8000-00000000ffff' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('surfaces a service-side authorization refusal as 403, not 503', async () => {
    const services = serviceFixtures()
    // The session's grants were stale; the in-transaction check is authoritative.
    services.paymentProviderService.listConfigurations.mockRejectedValue(
      new PaymentProviderError('PAYMENT_PROVIDER_OPERATION_FORBIDDEN'),
    )
    const { app } = await adminApp({ services })

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(403)
  })

  it.each([
    ['PROVIDER_CONFIGURATION_NOT_FOUND', 404],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE', 422],
  ])('maps %s to HTTP %i', async (code, status) => {
    const services = serviceFixtures()
    services.paymentProviderService.setConfigurationHealth.mockRejectedValue(
      new PaymentProviderError(code),
    )
    const { app } = await adminApp({ services })

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: `/api/v1/admin/payment-providers/configurations/${configurationId}/health`,
      payload: { healthStatus: 'HEALTHY', reason: 'Verified a live test transaction' },
    })

    expect(response.statusCode).toBe(status)
    expect(response.json().error.code).toBe(code)
  })

  it('reports an unexpected persistence failure as 503 without leaking detail', async () => {
    const services = serviceFixtures()
    services.paymentProviderService.listConfigurations.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    )
    const { app } = await adminApp({ services })

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('PROVIDER_GOVERNANCE_UNAVAILABLE')
    expect(response.body).not.toContain('ECONNREFUSED')
  })

  it('configures an SMS provider under its own permission', async () => {
    const services = serviceFixtures()
    const { app } = await adminApp({ grants: [grant([DELIVERY_PERMISSION])], services })

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/sms-providers/configurations',
      payload: smsCommand,
    })

    expect(response.statusCode).toBe(201)
    const [calledTenantId, command] = services.authDeliveryProviderService.createConfiguration.mock
      .calls[0] as [string, { actor: string; actorId: string; priority?: number }]
    expect(calledTenantId).toBe(tenantId)
    expect(command.actor).toBe('STAFF')
    expect(command.actorId).toBe(accountId)
    // Omitted rather than sent as undefined, so the service applies its default.
    expect('priority' in command).toBe(false)
  })

  it('takes an SMS provider out of rotation with an audited reason', async () => {
    const services = serviceFixtures()
    const { app } = await adminApp({ grants: [grant([DELIVERY_PERMISSION])], services })

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: `/api/v1/admin/sms-providers/configurations/${configurationId}/health`,
      payload: { healthStatus: 'UNHEALTHY', reason: 'Provider outage reported by operations' },
    })

    expect(response.statusCode).toBe(200)
    const [, command] = services.authDeliveryProviderService.setConfigurationHealth.mock
      .calls[0] as [string, { configurationId: string; healthStatus: string; reason: string }]
    expect(command.configurationId).toBe(configurationId)
    expect(command.healthStatus).toBe('UNHEALTHY')
    expect(command.reason).toBe('Provider outage reported by operations')
  })

  it('refuses to reset an SMS provider to UNKNOWN', async () => {
    const services = serviceFixtures()
    const { app } = await adminApp({ grants: [grant([DELIVERY_PERMISSION])], services })

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: `/api/v1/admin/sms-providers/configurations/${configurationId}/health`,
      payload: { healthStatus: 'UNKNOWN', reason: 'Attempting to clear observed state' },
    })

    expect(response.statusCode).toBe(400)
    expect(services.authDeliveryProviderService.setConfigurationHealth).not.toHaveBeenCalled()
  })

  it('maps an immutable-configuration conflict to 409', async () => {
    const services = serviceFixtures()
    services.authDeliveryProviderService.createConfiguration.mockRejectedValue(
      new AuthDeliveryProviderError('AUTH_DELIVERY_DEFAULT_ALREADY_EXISTS'),
    )
    const { app } = await adminApp({ grants: [grant([DELIVERY_PERMISSION])], services })

    const response = await app.inject({
      method: 'POST',
      headers: staffHeaders,
      url: '/api/v1/admin/sms-providers/configurations',
      payload: smsCommand,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('AUTH_DELIVERY_DEFAULT_ALREADY_EXISTS')
  })

  it('is not registered at all when no admin services are configured', async () => {
    const app = await buildApp({ auth: authFixture([grant([PAYMENT_PERMISSION])]) })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      headers: staffHeaders,
      url: '/api/v1/admin/payment-providers/configurations',
    })

    expect(response.statusCode).toBe(404)
  })
})
