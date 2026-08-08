import { randomBytes, randomUUID } from 'node:crypto'

import * as Sentry from '@sentry/node'

import { getEnv, parseCorsOrigins } from '@alo-noon/config'
import { PrismaClient } from '@alo-noon/database'
import {
  createAuthenticationDeliveryPolicy,
  createAuthenticationDeliveryRegistry,
  createPaymentProviderAdapterRegistry,
  createProviderExecutionPolicy,
} from '@alo-noon/domain'

import { buildApp } from './app.js'
import {
  createPrismaCatalogRepository,
  createPrismaCityRepository,
  createPrismaServiceabilityRepository,
} from './modules/discovery.js'
import { createPrismaAuthRepository } from './modules/auth.js'
import {
  authenticationDatabaseRoleIsSafe,
  createEnvironmentAuthenticationCredentialResolver,
  createPrismaAuthenticationDeliveryService,
} from './modules/auth-delivery.js'
import { createPrismaAdminReportingService } from './modules/admin-reporting.js'
import { createPrismaAdminFinancialReportingService } from './modules/admin-financial-reporting.js'
import { createPrismaAdminCatalogService } from './modules/admin-catalog.js'
import { createPrismaAdminAccessService } from './modules/admin-access.js'
import { createPrismaOrderOperationsService } from './modules/order-operations.js'
import { createPrismaAuthDeliveryProviderService } from './modules/auth-delivery-provider.js'
import { createPrismaCommerceRepository } from './modules/commerce.js'
import { createPrismaAddressRepository } from './modules/addresses.js'
import { createPrismaOrderRepository } from './modules/orders.js'
import { createPrismaPaymentExecutionService } from './modules/payment-execution.js'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger.js'
import { createPrismaPaymentSettlementService } from './modules/payment-settlement.js'
import { createPaymentSecretResolver } from './providers/secret-resolver.js'
import { createPrismaPaymentProviderService } from './modules/payment-provider.js'
import { createIdPayAdapter } from './providers/idpay.js'
import { createNextPayAdapter } from './providers/nextpay.js'
import { createShepaAdapter } from './providers/shepa.js'

const env = getEnv()

// Frequent enough that a stranded payment is noticed in minutes, bounded so a
// backlog cannot turn the sweep into a load test against the checkout database.
const SETTLEMENT_SWEEP_INTERVAL_MS = 60_000
const SETTLEMENT_SWEEP_BATCH = 25

// Error reporting is opt-in: without SENTRY_DSN this stays fully inert, so
// development and CI never depend on an external service being reachable.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
  })
}

const prisma = new PrismaClient()
const otpPepper = env.AUTH_OTP_PEPPER ?? randomBytes(32).toString('hex')
const abusePepper = env.AUTH_ABUSE_PEPPER ?? randomBytes(32).toString('hex')
const authenticationDeliveryRegistry = createAuthenticationDeliveryRegistry([])
const authenticationDeliveryPolicy = createAuthenticationDeliveryPolicy({
  environment: env.NODE_ENV === 'production' ? 'PRODUCTION' : 'TEST',
  otpTtlMs: 5 * 60_000,
  resendCooldownMs: 60_000,
  maxVerificationAttempts: 5,
  maxPhoneSendsPerHour: 5,
  maxIpSendsPerTenMinutes: 20,
  maxTenantSendsPerHour: 500,
  // Well under the 12,000 the hourly cap alone would allow across a full day.
  maxTenantSendsPerDay: 5_000,
  maxProviderSendsPerMinute: 300,
  circuitFailureThreshold: 5,
  circuitOpenMs: 5 * 60_000,
  invocationTimeoutMs: 5_000,
  maxPersistenceAttempts: 3,
})
const auth = {
  repository: createPrismaAuthRepository(prisma),
  deliveryService: createPrismaAuthenticationDeliveryService(prisma, {
    registry: authenticationDeliveryRegistry,
    credentialResolver: createEnvironmentAuthenticationCredentialResolver(process.env),
    policy: authenticationDeliveryPolicy,
    otpPepper,
    abusePepper,
  }),
  otpPepper,
  abusePepper,
  sessionPepper: env.AUTH_SESSION_PEPPER ?? randomBytes(32).toString('hex'),
  secureCookie: env.NODE_ENV === 'production',
}
// Adapters alone do not make a gateway live for any tenant: selectPaymentProvider
// only finds one once an operator provisions a matching, active, healthy, default
// PaymentProviderConfiguration + ProviderCredentialReference for that tenant —
// from the admin routes below, or from the provisioning CLI. Until
// PAYMENT_CALLBACK_BASE_URL is set, no adapter is registered at all and the route
// fails safely with PAYMENT_PROVIDER_MISSING (503) instead of not existing.
// Each gateway gets its own callback path so the receiving route knows which
// provider a redirect belongs to without trusting a request parameter for it.
const callbackUrlFor = (providerCode: string): string | undefined =>
  env.PAYMENT_CALLBACK_BASE_URL
    ? new URL(
        `/api/v1/payments/callback/${providerCode.toLowerCase()}`,
        env.PAYMENT_CALLBACK_BASE_URL,
      ).toString()
    : undefined
const paymentProviderAdapterRegistry = createPaymentProviderAdapterRegistry(
  env.PAYMENT_CALLBACK_BASE_URL
    ? [
        createNextPayAdapter({ callbackUrl: callbackUrlFor('NEXTPAY')! }),
        createShepaAdapter({ callbackUrl: callbackUrlFor('SHEPA')! }),
        createIdPayAdapter({ callbackUrl: callbackUrlFor('IDPAY')! }),
      ]
    : [],
)
const paymentExecutionPolicy = createProviderExecutionPolicy({
  environment: env.NODE_ENV === 'production' ? 'PRODUCTION' : 'TEST',
  maxPersistenceAttempts: 3,
  invocationTimeoutMs: 10_000,
})
const paymentExecutionService = createPrismaPaymentExecutionService(prisma, {
  adapterRegistry: paymentProviderAdapterRegistry,
  secretResolver: createPaymentSecretResolver(process.env, env.PAYMENT_SECRET_ENCRYPTION_KEY),
  policy: paymentExecutionPolicy,
})

// Recording an inbound gateway redirect and settling it are both system-actor
// writes, so this service instance is deliberately separate from any
// customer-driven or staff-driven one.
const systemProviderService = createPrismaPaymentProviderService(prisma, {
  allowSystemOperations: true,
  adapterRegistry: paymentProviderAdapterRegistry,
})
// One ledger service, shared: settlement walks a payment to captured, and the
// customer-facing checkout opens it in the first place. Two instances would be
// two retry budgets over the same rows for no reason.
const paymentLedgerService = createPrismaPaymentLedgerService(prisma)

const paymentSettlementService = createPrismaPaymentSettlementService(prisma, {
  adapterRegistry: paymentProviderAdapterRegistry,
  secretResolver: createPaymentSecretResolver(process.env, env.PAYMENT_SECRET_ENCRYPTION_KEY),
  ledgerService: paymentLedgerService,
  providerService: systemProviderService,
})

const paymentCheckout = { service: paymentLedgerService }

const paymentCallback = env.PAYMENT_RESULT_REDIRECT_URL
  ? {
      providerService: systemProviderService,
      settlementService: paymentSettlementService,
      resultRedirectUrl: env.PAYMENT_RESULT_REDIRECT_URL,
      environment: paymentExecutionPolicy.environment,
    }
  : undefined

// Staff-driven governance. `allowSystemOperations` is deliberately absent: every
// write through these services must be attributable to a real account holding a
// GLOBAL governance grant, which the services verify inside their own write
// transactions. Only the provisioning CLI opts into SYSTEM operations.
const adminProviders = {
  paymentProviderService: createPrismaPaymentProviderService(prisma, {
    adapterRegistry: paymentProviderAdapterRegistry,
  }),
  authDeliveryProviderService: createPrismaAuthDeliveryProviderService(prisma),
}

// Read-only, and gated on its own permissions, so it shares no service instance
// with the governance path above.
const adminReporting = {
  service: createPrismaAdminReportingService(prisma),
  financialService: createPrismaAdminFinancialReportingService(prisma),
}

// Catalogue writes re-check the acting account's permission inside their own
// transaction, so this instance carries no ambient authority of its own.
const adminCatalog = { service: createPrismaAdminCatalogService(prisma) }

// Access management is its own service so that `admin.access.manage` can be
// withheld from an otherwise fully privileged operator.
const adminAccess = { service: createPrismaAdminAccessService(prisma) }

// Order operations re-check admin.orders.manage inside their own write
// transaction, so this instance carries no ambient authority of its own.
const orderOperations = {
  service: createPrismaOrderOperationsService(prisma, { ledgerService: paymentLedgerService }),
}

const app = await buildApp({
  logger: true,
  ...(env.API_TRUST_PROXY_HOPS !== undefined && { trustProxyHops: env.API_TRUST_PROXY_HOPS }),
  readinessCheck: async () => {
    await prisma.$queryRaw`SELECT 1`
    return env.NODE_ENV !== 'production' || authenticationDatabaseRoleIsSafe(prisma)
  },
  authenticationDeliveryReadinessCheck: async () =>
    env.NODE_ENV !== 'production' ||
    authenticationDeliveryRegistry.identities().some((identity) => !identity.testOnly),
  catalogRepository: createPrismaCatalogRepository(prisma),
  cityRepository: createPrismaCityRepository(prisma),
  serviceabilityRepository: createPrismaServiceabilityRepository(prisma),
  corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
  auth,
  commerceRepository: createPrismaCommerceRepository(prisma),
  addressRepository: createPrismaAddressRepository(prisma),
  orderRepository: createPrismaOrderRepository(prisma),
  paymentExecutionService,
  paymentCheckout,
  ...(paymentCallback && { paymentCallback }),
  adminProviders,
  adminReporting,
  adminCatalog,
  adminAccess,
  orderOperations,
})

if (env.SENTRY_DSN) {
  Sentry.setupFastifyErrorHandler(app)
}

/**
 * Recovers callbacks the inline path could not settle: a gateway that was
 * unreachable, a customer who closed the tab before the redirect landed, a
 * process that died mid-flight. Without this a real payment can sit taken from
 * the customer and unrecorded by us indefinitely.
 *
 * Deliberately a plain interval rather than a queue: it is idempotent, bounded,
 * and this deployment has one API process. Several processes would each sweep,
 * which is safe — the verdict is terminal and the second writer is refused —
 * just wasteful.
 */
const settlementSweep = setInterval(() => {
  void (async () => {
    try {
      const tenants = await prisma.tenant.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      })
      for (const tenant of tenants) {
        const results = await paymentSettlementService.settlePending(
          tenant.id,
          SETTLEMENT_SWEEP_BATCH,
          new Date(),
          randomUUID(),
        )
        const unresolved = results.filter((result) => result.status === 'PENDING')
        if (unresolved.length > 0) {
          app.log.warn(
            { tenantId: tenant.id, pending: unresolved.length },
            'Payment callbacks still awaiting settlement',
          )
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'Payment settlement sweep failed')
    }
  })()
}, SETTLEMENT_SWEEP_INTERVAL_MS)
settlementSweep.unref()

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down')
  clearInterval(settlementSweep)
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void close(signal))
}

await app.listen({ host: '0.0.0.0', port: env.API_PORT })
