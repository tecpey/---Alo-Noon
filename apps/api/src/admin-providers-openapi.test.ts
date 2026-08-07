import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildApp } from './app'

const openapi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

const ADMIN_PATHS = [
  '/api/v1/admin/payment-providers/credentials:',
  '/api/v1/admin/payment-providers/configurations:',
  '/api/v1/admin/payment-providers/configurations/{configurationId}/governance:',
  '/api/v1/admin/payment-providers/configurations/{configurationId}/health:',
  '/api/v1/admin/sms-providers/configurations:',
  '/api/v1/admin/sms-providers/configurations/{configurationId}/health:',
]

describe('admin provider governance OpenAPI boundary', () => {
  it.each(ADMIN_PATHS)('documents %s', (path) => {
    expect(openapi).toContain(path)
  })

  it('requires a session on every admin operation', () => {
    const adminSection = openapi.slice(
      openapi.indexOf('/api/v1/admin/payment-providers/credentials:'),
      openapi.indexOf('/api/v1/serviceability/check:'),
    )
    const operations = adminSection.match(/^ {4}(get|post|put|patch|delete):$/gm) ?? []
    const secured = adminSection.match(/^ {6}security: /gm) ?? []
    expect(operations.length).toBe(ADMIN_PATHS.length + 2)
    expect(secured.length).toBe(operations.length)
    // An unauthorized caller must be a documented outcome, not a surprise.
    expect(adminSection).toContain("'403'")
  })

  it('accepts credentials only by reference, never by value', () => {
    const adminSection = openapi.slice(
      openapi.indexOf('AdminProviderCredentialCreate:'),
      openapi.indexOf('AdminAuthDeliveryConfigurationListEnvelope:'),
    )
    expect(adminSection).not.toMatch(/apiKey|secret|password|token|merchantPassword/i)
    expect(adminSection).toContain("$ref: '#/components/schemas/ProviderCredentialReference'")
  })

  it('never returns a credential reference or its material in a summary', () => {
    const summary = openapi.slice(
      openapi.indexOf('AdminProviderCredentialSummary:'),
      openapi.indexOf('AdminProviderCredentialEnvelope:'),
    )
    expect(summary).toContain('keyVersion')
    expect(summary).not.toContain('reference:')
  })

  it('registers every documented admin operation, and gates each one', async () => {
    const app = await buildApp({
      auth: {
        repository: {
          resolveTenantByHost: async () => null,
          findSession: async () => null,
        },
        deliveryService: { request: async () => Promise.reject(new Error('unused')) },
        otpPepper: 'p',
        abusePepper: 'p',
        sessionPepper: 'p',
        secureCookie: false,
      } as never,
      // Empty services: an unauthenticated request must be refused before any
      // of them is reached, so a missing method here would surface as a 500.
      adminProviders: {
        paymentProviderService: {} as never,
        authDeliveryProviderService: {} as never,
      },
    })

    const operations = ADMIN_PATHS.flatMap((path) => {
      const url = path.replace('{configurationId}', 'c1').slice(0, -1)
      return path.endsWith('configurations:')
        ? [
            { method: 'GET' as const, url },
            { method: 'POST' as const, url },
          ]
        : [{ method: 'POST' as const, url }]
    })

    for (const operation of operations) {
      const response = await app.inject({ ...operation, payload: {} })
      expect(`${operation.method} ${operation.url} -> ${response.statusCode}`).toBe(
        `${operation.method} ${operation.url} -> 401`,
      )
    }
    await app.close()
  })
})
