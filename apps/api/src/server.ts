import { getEnv } from '@alo-noon/config'
import { PrismaClient } from '@alo-noon/database'

import { buildApp } from './app.js'

const env = getEnv()
const prisma = new PrismaClient()
const app = await buildApp({
  logger: true,
  readinessCheck: async () => {
    await prisma.$queryRaw`SELECT 1`
    return true
  },
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
