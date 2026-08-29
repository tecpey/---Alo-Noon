import { randomBytes, randomUUID } from 'node:crypto'

import * as Sentry from '@sentry/node'

import { getEnv, parseCorsOrigins } from '@alo-noon/config'
import { PrismaClient } from '@alo-noon/database'
import {
  createAuthenticationDeliveryPolicy,
  createAuthenticationDeliveryRegistry,
  createPaymentProviderAdapterRegistry,
  createRoutingProviderRegistry,
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
import { createPrismaAdminLogisticsService } from './modules/admin-logistics.js'
import { createPrismaAdminFinancialReportingService } from './modules/admin-financial-reporting.js'
import { createPrismaAdminCatalogService } from './modules/admin-catalog.js'
import { createPrismaAdminAccessService } from './modules/admin-access.js'
import { createPrismaAdminMessagingService } from './modules/admin-messaging.js'
import { createPrismaCustomerNotificationService } from './modules/customer-notifications.js'
import { createPrismaOutboxPublisher } from './modules/outbox-publisher.js'
import {
  createEnvironmentRoutingCredentialResolver,
  createPrismaRoutingService,
} from './modules/routing.js'
import { createLimoSmsAdapter } from './providers/limosms.js'
import { createPrismaDeliveryService } from './modules/delivery.js'
import { createPrismaCourierAssignmentService } from './modules/courier-assignment.js'
import { createPrismaDeliveryTripService } from './modules/delivery-trips.js'
import { createPrismaOrderOperationsService } from './modules/order-operations.js'
import { createPrismaAuthDeliveryProviderService } from './modules/auth-delivery-provider.js'
import { createPrismaCommerceRepository } from './modules/commerce.js'
import { createPrismaAddressRepository } from './modules/addresses.js'
import { createPrismaOrderRepository } from './modules/orders.js'
import { createPrismaPaymentExecutionService } from './modules/payment-execution.js'
import { createPrismaCashOnDeliveryService } from './modules/cash-on-delivery.js'
import { createPrismaEngagementService } from './modules/engagement.js'
import { createPrismaPaymentLedgerService } from './modules/payment-ledger.js'
import { createPrismaPaymentSettlementService } from './modules/payment-settlement.js'
import { createPaymentSecretResolver } from './providers/secret-resolver.js'
import { createPrismaPaymentProviderService } from './modules/payment-provider.js'
import { createIdPayAdapter } from './providers/idpay.js'
import { createNextPayAdapter } from './providers/nextpay.js'
import { createShepaAdapter } from './providers/shepa.js'
import { createZarinpalAdapter } from './providers/zarinpal.js'
import { createZibalAdapter } from './providers/zibal.js'
import { createNeshanAdapter } from './providers/neshan.js'

const env = getEnv()

// Frequent enough that a stranded payment is noticed in minutes, bounded so a
// backlog cannot turn the sweep into a load test against the checkout database.
const SETTLEMENT_SWEEP_INTERVAL_MS = 60_000
const SETTLEMENT_SWEEP_BATCH = 25

// Faster than settlement because this is what a customer is waiting on: a text
// saying the bread is ready is worth little ten minutes after it was. Bounded
// so a backlog after an outage drains steadily rather than arriving as a burst
// of messages the tenant pays for all at once.
const OUTBOX_SWEEP_INTERVAL_MS = 15_000
const OUTBOX_SWEEP_BATCH = 50

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
// The one real OTP gateway. Registered unconditionally: it reads nothing at
// construction time, and the credential is resolved per send from the
// configuration's own reference, so an unconfigured deployment simply never
// selects it rather than failing to boot.
// The endpoint is overridable so a deployment can be smoke-tested against a
// sandbox before it is pointed at the real gateway. Unset means the real one.
const limoSmsAdapter = createLimoSmsAdapter(
  env.AUTH_SMS_LIMOSMS_ENDPOINT ? { endpoint: env.AUTH_SMS_LIMOSMS_ENDPOINT } : {},
)
const authenticationDeliveryRegistry = createAuthenticationDeliveryRegistry([limoSmsAdapter])
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
        createZarinpalAdapter({
          callbackUrl: callbackUrlFor('ZARINPAL')!,
          ...(env.PAYMENT_ZARINPAL_ENDPOINT !== undefined && {
            endpointOrigin: env.PAYMENT_ZARINPAL_ENDPOINT,
          }),
        }),
        createZibalAdapter({
          callbackUrl: callbackUrlFor('ZIBAL')!,
          ...(env.PAYMENT_ZIBAL_ENDPOINT !== undefined && {
            endpointOrigin: env.PAYMENT_ZIBAL_ENDPOINT,
          }),
        }),
      ]
    : [],
)
// Routing is optional in a way payments are not: a tenant with no routing engine
// still sells bread, priced on the scaled straight line. So the registry is
// always built and the service always exists — what varies is whether any
// tenant has a configuration pointing at it.
const routingProviderRegistry = createRoutingProviderRegistry([
  createNeshanAdapter(
    env.ROUTING_NESHAN_ENDPOINT ? { endpointOrigin: env.ROUTING_NESHAN_ENDPOINT } : {},
  ),
])
const routingService = createPrismaRoutingService(prisma, {
  registry: routingProviderRegistry,
  credentialResolver: createEnvironmentRoutingCredentialResolver(process.env),
  environment: env.NODE_ENV === 'production' ? 'PRODUCTION' : 'TEST',
})

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

// Message wording is governed by notification-provider.configuration.govern, so
// an operator trusted with gateways is trusted with what those gateways say.
const adminMessaging = { service: createPrismaAdminMessagingService(prisma) }

// Customer notifications go out over the same SMS gateway that carries sign-in
// codes, but through their own path: the wording comes from the tenant's
// editable templates, and each message is claimed once per order step so an
// event retried after a crash cannot text anyone twice.
const customerNotificationService = createPrismaCustomerNotificationService(prisma, {
  providers: [limoSmsAdapter],
  credentialResolver: createEnvironmentAuthenticationCredentialResolver(process.env),
  environment: authenticationDeliveryPolicy.environment,
  messagingService: adminMessaging.service,
})
const outboxPublisher = createPrismaOutboxPublisher(prisma, {
  notificationService: customerNotificationService,
})

// Order operations re-check admin.orders.manage inside their own write
// transaction, so this instance carries no ambient authority of its own.
const orderOperations = {
  service: createPrismaOrderOperationsService(prisma, { ledgerService: paymentLedgerService }),
}

// Dispatch and the courier app share one service. A courier holds no admin
// grant at all — their authority is the assignment offered to them, which the
// service checks against the row on every write.
// Cash at the door. Shares the one ledger service, because a cash collection
// is a capture like any other — only the account it debits differs, and that
// difference is the whole feature.
const cashOnDeliveryService = createPrismaCashOnDeliveryService(prisma, {
  ledger: paymentLedgerService,
})
// The courier's delivery report is where cash changes hands, so the delivery
// routes carry the cash service and post the money the moment they are told.
const delivery = {
  service: createPrismaDeliveryService(prisma),
  cashOnDelivery: cashOnDeliveryService,
}
// One engagement service, shared: the customer surfaces read it and the
// operator's quality report reads it, and two instances would be two pools
// over the same rows for no reason.
const engagementService = createPrismaEngagementService(prisma)
// The planner uses road distances where a routing engine is configured and the
// straight line where one is not. That is not cosmetic: two doors fifty metres
// apart with a river between them are a good batch on a map and a bad one in
// life.
const deliveryTrips = {
  service: createPrismaDeliveryTripService(prisma, { routingService }),
}
// Proposes pairings only. Nothing here offers work to a courier: the position
// it reasons from is where a rider last delivered, not where they are, and a
// guess that good is worth showing a dispatcher and not worth acting on alone.
const courierAssignments = {
  service: createPrismaCourierAssignmentService(prisma),
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
  commerceRepository: createPrismaCommerceRepository(prisma, { routingService }),
  addressRepository: createPrismaAddressRepository(prisma),
  orderRepository: createPrismaOrderRepository(prisma),
  paymentExecutionService,
  paymentCheckout,
  ...(paymentCallback && { paymentCallback }),
  adminProviders,
  adminReporting,
  adminLogistics: { service: createPrismaAdminLogisticsService(prisma) },
  adminCatalog,
  adminAccess,
  adminMessaging,
  orderOperations,
  delivery,
  deliveryTrips,
  courierAssignments,
  cash: { service: cashOnDeliveryService, engagement: engagementService },
  // Coming back: ordering again, rating, favourites. Reorder is the one that
  // earns the second order, which for a daily staple is most of the business.
  engagement: { service: engagementService },
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

/**
 * Turns committed domain events into the messages they imply.
 *
 * Separate from the transitions that write those events on purpose: a slow or
 * unreachable SMS gateway must not be able to fail an order step an operator
 * has already acted on, and a send swallowed inline would never be retried.
 */
const outboxSweep = setInterval(() => {
  void (async () => {
    try {
      const tenants = await prisma.tenant.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      })
      for (const tenant of tenants) {
        const summary = await outboxPublisher.publish(tenant.id, OUTBOX_SWEEP_BATCH, new Date())
        if (summary.failed > 0) {
          // Parked events: nobody will retry these, and each one is a customer
          // who was not told something.
          app.log.error(
            { tenantId: tenant.id, failed: summary.failed },
            'Domain events exhausted their publish attempts',
          )
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'Outbox publish sweep failed')
    }
  })()
}, OUTBOX_SWEEP_INTERVAL_MS)
outboxSweep.unref()

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down')
  clearInterval(settlementSweep)
  clearInterval(outboxSweep)
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void close(signal))
}

await app.listen({ host: '0.0.0.0', port: env.API_PORT })
