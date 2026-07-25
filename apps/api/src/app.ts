import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'

import type { HealthResponse, ReadyResponse } from '@alo-noon/contracts'

export interface AppOptions {
  readinessCheck?: () => Promise<boolean>
  logger?: boolean
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const readinessCheck = options.readinessCheck ?? (async () => true)

  await app.register(cors, { origin: false })

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

function responseMeta() {
  return {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    version: 'v1',
  }
}
