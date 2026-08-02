import { randomBytes } from 'node:crypto'

import { getEnv, parseCorsOrigins } from '@alo-noon/config'
import { PrismaClient } from '@alo-noon/database'

import { buildApp } from './app.js'
import {
  createPrismaCatalogRepository,
  createPrismaCityRepository,
  createPrismaServiceabilityRepository,
} from './modules/discovery.js'
import { createPrismaAuthRepository, type OtpDeliveryProvider } from './modules/auth.js'
import { createPrismaCommerceRepository } from './modules/commerce.js'
import { createPrismaAddressRepository } from './modules/addresses.js'
import { createPrismaOrderRepository } from './modules/orders.js'

const env = getEnv()
const prisma = new PrismaClient()
const unavailableOtpDeliveryProvider: OtpDeliveryProvider = {
  send: async () => {
    throw new Error('No approved OTP delivery provider is configured')
  },
}
const auth = {
  repository: createPrismaAuthRepository(prisma),
  deliveryProvider: unavailableOtpDeliveryProvider,
  otpPepper: env.AUTH_OTP_PEPPER ?? randomBytes(32).toString('hex'),
  sessionPepper: env.AUTH_SESSION_PEPPER ?? randomBytes(32).toString('hex'),
  secureCookie: env.NODE_ENV === 'production',
}
const app = await buildApp({
  logger: true,
  readinessCheck: async () => {
    await prisma.$queryRaw`SELECT 1`
    return true
  },
  catalogRepository: createPrismaCatalogRepository(prisma),
  cityRepository: createPrismaCityRepository(prisma),
  serviceabilityRepository: createPrismaServiceabilityRepository(prisma),
  corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
  auth,
  commerceRepository: createPrismaCommerceRepository(prisma),
  addressRepository: createPrismaAddressRepository(prisma),
  orderRepository: createPrismaOrderRepository(prisma),
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
