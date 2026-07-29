import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

describe('operational endpoints', () => {
  it('reports process health', async () => {
    const app = await buildApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, data: { status: 'healthy' } })
  })

  it('returns 503 when a dependency is unavailable', async () => {
    const app = await buildApp({ readinessCheck: async () => false })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ success: false, data: { ready: false } })
  })

  it('allows credentials only for configured browser origins', async () => {
    const app = await buildApp({ corsOrigins: ['http://localhost:8081'] })
    apps.push(app)

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/serviceability/cities',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'GET',
      },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:8081')
    expect(allowed.headers['access-control-allow-credentials']).toBe('true')

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/serviceability/cities',
      headers: {
        origin: 'https://attacker.invalid',
        'access-control-request-method': 'GET',
      },
    })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })
})
