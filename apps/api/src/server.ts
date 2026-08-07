import { randomBytes } from 'node:crypto'

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
import { createPrismaCommerceRepository } from './modules/commerce.js'
import { createPrismaAddressRepository } from './modules/addresses.js'
import { createPrismaOrderRepository } from './modules/orders.js'
import {
  createEnvironmentPaymentCredentialResolver,
  createPrismaPaymentExecutionService,
} from './modules/payment-execution.js'
import { createIdPayAdapter } from './providers/idpay.js'
import { createNextPayAdapter } from './providers/nextpay.js'
import { createShepaAdapter } from './providers/shepa.js'

const env = getEnv()

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
// PaymentProviderConfiguration + ProviderCredentialReference for that tenant via
// createPrismaPaymentProviderService (no HTTP route exists for that yet, so it is
// currently a script/console action). Until PAYMENT_CALLBACK_BASE_URL is set, no
// adapter is registered at all and the route fails safely with
// PAYMENT_PROVIDER_MISSING (503) instead of not existing.
const paymentCallbackUrl = env.PAYMENT_CALLBACK_BASE_URL
  ? new URL('/api/v1/payments/callback', env.PAYMENT_CALLBACK_BASE_URL).toString()
  : undefined
const paymentProviderAdapterRegistry = createPaymentProviderAdapterRegistry(
  paymentCallbackUrl
    ? [
        createNextPayAdapter({ callbackUrl: paymentCallbackUrl }),
        createShepaAdapter({ callbackUrl: paymentCallbackUrl }),
        createIdPayAdapter({ callbackUrl: paymentCallbackUrl }),
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
  secretResolver: createEnvironmentPaymentCredentialResolver(process.env),
  policy: paymentExecutionPolicy,
})

const app = await buildApp({
  logger: true,
  trustProxyHops: env.API_TRUST_PROXY_HOPS,
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
})

if (env.SENTRY_DSN) {
  Sentry.setupFastifyErrorHandler(app)
}

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down')
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void close(signal))
}

await app.listen({ host: '0.0.0.0', port: env.API_PORT })
