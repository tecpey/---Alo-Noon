import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'

import type { HealthResponse, ReadyResponse, ResponseMeta } from '@alo-noon/contracts'

import {
  registerDiscoveryRoutes,
  type CatalogRepository,
  type ServiceabilityRepository,
} from './modules/discovery.js'
import { registerAuthRoutes, type AuthDependencies } from './modules/auth.js'

export interface AppOptions {
  readinessCheck?: () => Promise<boolean>
  catalogRepository?: CatalogRepository
  serviceabilityRepository?: ServiceabilityRepository
  auth?: AuthDependencies
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

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const readinessCheck = options.readinessCheck ?? (async () => true)

  await app.register(cors, { origin: false })
  registerDiscoveryRoutes(app, {
    catalogRepository: options.catalogRepository ?? unavailableCatalogRepository,
    serviceabilityRepository:
      options.serviceabilityRepository ?? unavailableServiceabilityRepository,
  })
  if (options.auth) registerAuthRoutes(app, options.auth)

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
