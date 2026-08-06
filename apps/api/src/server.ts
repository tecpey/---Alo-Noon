import { randomBytes } from 'node:crypto'

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

const env = getEnv()
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
// No adapter is registered yet: no Iranian payment gateway has been approved and
// integrated. Registering the route now (instead of omitting it) means a request
// fails safely with PAYMENT_PROVIDER_MISSING/PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE
// (503) instead of the route not existing at all, and the moment a real adapter is
// added to this array plus a matching PaymentProviderConfiguration is provisioned,
// no further server wiring changes are required.
const paymentProviderAdapterRegistry = createPaymentProviderAdapterRegistry([])
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
