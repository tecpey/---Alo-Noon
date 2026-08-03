import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'

import type { HealthResponse, ReadyResponse, ResponseMeta } from '@alo-noon/contracts'

import {
  registerDiscoveryRoutes,
  type CatalogRepository,
  type CityRepository,
  type ServiceabilityRepository,
} from './modules/discovery.js'
import { registerAuthRoutes, type AuthDependencies } from './modules/auth.js'
import {
  registerCommerceRoutes,
  type CommerceDependencies,
  type CommerceRepository,
} from './modules/commerce.js'
import { registerAddressRoutes, type AddressRepository } from './modules/addresses.js'
import { registerOrderRoutes, type OrderRepository } from './modules/orders.js'
import {
  registerPaymentExecutionRoutes,
  type PaymentExecutionService,
} from './modules/payment-execution.js'

export interface AppOptions {
  readinessCheck?: () => Promise<boolean>
  catalogRepository?: CatalogRepository
  cityRepository?: CityRepository
  serviceabilityRepository?: ServiceabilityRepository
  auth?: AuthDependencies
  commerceRepository?: CommerceRepository
  addressRepository?: AddressRepository
  orderRepository?: OrderRepository
  paymentExecutionService?: PaymentExecutionService
  corsOrigins?: string[]
  logger?: boolean
}

const unavailableCatalogRepository: CatalogRepository = {
  listProducts: async () => {
    throw new Error('Catalog repository unavailable')
  },
}

const unavailableServiceabilityRepository: ServiceabilityRepository = {
  isCityActive: async () => {
    throw new Error('Serviceability repository unavailable')
  },
  listAreas: async () => {
    throw new Error('Serviceability repository unavailable')
  },
}

const unavailableCityRepository: CityRepository = {
  listActiveCities: async () => {
    throw new Error('City repository unavailable')
  },
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const readinessCheck = options.readinessCheck ?? (async () => true)

  await app.register(cors, {
    origin: options.corsOrigins?.length ? options.corsOrigins : false,
    credentials: true,
  })
  registerDiscoveryRoutes(app, {
    catalogRepository: options.catalogRepository ?? unavailableCatalogRepository,
    cityRepository: options.cityRepository ?? unavailableCityRepository,
    serviceabilityRepository:
      options.serviceabilityRepository ?? unavailableServiceabilityRepository,
    ...(options.auth && { auth: options.auth }),
  })
  if (options.auth) registerAuthRoutes(app, options.auth)
  if (options.auth && options.commerceRepository) {
    const commerce: CommerceDependencies = {
      repository: options.commerceRepository,
      auth: options.auth,
    }
    registerCommerceRoutes(app, commerce)
  }
  if (options.auth && options.addressRepository) {
    registerAddressRoutes(app, { repository: options.addressRepository, auth: options.auth })
  }
  if (options.auth && options.orderRepository) {
    registerOrderRoutes(app, { repository: options.orderRepository, auth: options.auth })
  }
  if (options.auth && options.paymentExecutionService) {
    registerPaymentExecutionRoutes(app, {
      service: options.paymentExecutionService,
      auth: options.auth,
    })
  }

  app.get('/health', async (): Promise<HealthResponse> => ({
    success: true,
    data: {
      status: 'healthy',
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? '0.0.1',
      checks: [{ name: 'process', status: 'pass' }],
    },
    meta: responseMeta(),
  }))

  app.get('/ready', async (_request, reply): Promise<ReadyResponse> => {
    const databaseReady = await readinessCheck().catch(() => false)
    if (!databaseReady) reply.code(503)

    return {
      success: databaseReady,
      data: {
        ready: databaseReady,
        checks: [
          {
            name: 'database',
            ready: databaseReady,
            ...(!databaseReady && { message: 'Database connection unavailable' }),
          },
        ],
      },
      meta: responseMeta(),
    }
  })

  return app
}

function responseMeta(): ResponseMeta {
  return {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}
