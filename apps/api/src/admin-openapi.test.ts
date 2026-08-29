import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildApp } from './app'

const openapi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

/**
 * Every documented admin operation, with the method each supports. The list is
 * spelled out rather than derived so that adding a route without documenting it
 * — or documenting one without registering it — fails here.
 */
const ADMIN_OPERATIONS: ReadonlyArray<{
  path: string
  methods: ReadonlyArray<'GET' | 'POST' | 'PATCH'>
}> = [
  { path: '/api/v1/admin/payment-providers/credentials', methods: ['POST'] },
  { path: '/api/v1/admin/payment-providers/configurations', methods: ['GET', 'POST'] },
  {
    path: '/api/v1/admin/payment-providers/configurations/{configurationId}/governance',
    methods: ['POST'],
  },
  {
    path: '/api/v1/admin/payment-providers/configurations/{configurationId}/health',
    methods: ['POST'],
  },
  { path: '/api/v1/admin/sms-providers/configurations', methods: ['GET', 'POST'] },
  {
    path: '/api/v1/admin/sms-providers/configurations/{configurationId}/health',
    methods: ['POST'],
  },
  { path: '/api/v1/admin/reports/sales', methods: ['GET'] },
  { path: '/api/v1/admin/reports/financial', methods: ['GET'] },
  { path: '/api/v1/admin/orders', methods: ['GET'] },
  { path: '/api/v1/admin/orders/{orderId}', methods: ['GET'] },
  { path: '/api/v1/admin/orders/{orderId}/accept', methods: ['POST'] },
  { path: '/api/v1/admin/orders/{orderId}/reject', methods: ['POST'] },
  { path: '/api/v1/admin/orders/{orderId}/start-fulfillment', methods: ['POST'] },
  { path: '/api/v1/admin/orders/{orderId}/complete', methods: ['POST'] },
  { path: '/api/v1/admin/orders/{orderId}/cancel', methods: ['POST'] },
  { path: '/api/v1/admin/orders/{orderId}/production', methods: ['POST'] },
  { path: '/api/v1/admin/catalog/categories', methods: ['GET', 'POST'] },
  { path: '/api/v1/admin/catalog/products', methods: ['GET', 'POST'] },
  { path: '/api/v1/admin/catalog/products/{productId}', methods: ['GET', 'PATCH'] },
  { path: '/api/v1/admin/catalog/products/{productId}/variants', methods: ['POST'] },
  { path: '/api/v1/admin/catalog/variants/{variantId}', methods: ['PATCH'] },
  { path: '/api/v1/admin/catalog/branches', methods: ['GET'] },
  { path: '/api/v1/admin/catalog/offerings', methods: ['GET', 'POST'] },
  { path: '/api/v1/admin/catalog/offerings/{offeringId}', methods: ['PATCH'] },
  { path: '/api/v1/admin/access/roles', methods: ['GET'] },
  { path: '/api/v1/admin/access/staff', methods: ['GET'] },
  { path: '/api/v1/admin/access/grants', methods: ['POST'] },
  { path: '/api/v1/admin/access/revocations', methods: ['POST'] },
]

/** The contiguous block of admin paths, which the spec keeps together. */
function adminSection(): string {
  const start = openapi.indexOf(`  ${ADMIN_OPERATIONS[0]!.path}:`)
  const end = openapi.indexOf('  /api/v1/serviceability/check:')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return openapi.slice(start, end)
}

describe('admin OpenAPI boundary', () => {
  it.each(ADMIN_OPERATIONS.map((operation) => operation.path))('documents %s', (path) => {
    expect(openapi).toContain(`  ${path}:`)
  })

  it('secures every admin operation, with no exceptions', () => {
    const section = adminSection()
    const operations = section.match(/^ {4}(get|post|put|patch|delete):$/gm) ?? []
    const secured = section.match(/^ {6}security: /gm) ?? []
    const expected = ADMIN_OPERATIONS.reduce((total, entry) => total + entry.methods.length, 0)
    expect(operations.length).toBe(expected)
    // One `security:` per operation. A single unsecured admin route is the whole
    // failure mode this section exists to prevent.
    expect(secured.length).toBe(operations.length)
    expect(section).toContain("'401'")
    expect(section).toContain("'403'")
  })

  it('accepts credentials only by reference, never by value', () => {
    const section = openapi.slice(
      openapi.indexOf('AdminProviderCredentialCreate:'),
      openapi.indexOf('AdminAuthDeliveryConfigurationListEnvelope:'),
    )
    expect(section).not.toMatch(/apiKey|secret|password|token|merchantPassword/i)
    expect(section).toContain("$ref: '#/components/schemas/ProviderCredentialReference'")
  })

  it('never returns a credential reference or its material in a summary', () => {
    const summary = openapi.slice(
      openapi.indexOf('AdminProviderCredentialSummary:'),
      openapi.indexOf('AdminProviderCredentialEnvelope:'),
    )
    expect(summary).toContain('keyVersion')
    expect(summary).not.toContain('reference:')
  })

  it('keeps the recipient phone out of the browsed order list', () => {
    // It is on detail, where an operator needs it to act, and nowhere else.
    const summary = openapi.slice(
      openapi.indexOf('    AdminOrderSummary:'),
      openapi.indexOf('    AdminOrderItem:'),
    )
    expect(summary).not.toContain('recipientPhoneSnapshot')
    expect(openapi.slice(openapi.indexOf('    AdminOrderDetail:'))).toContain(
      'recipientPhoneSnapshot',
    )
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
      // Empty services: an unauthenticated request must be refused before any of
      // them is reached, so a missing method would surface as a 500, not a 401.
      adminProviders: {
        paymentProviderService: {} as never,
        authDeliveryProviderService: {} as never,
        routingProviderService: {} as never,
      },
      adminReporting: { service: {} as never, financialService: {} as never },
      adminCatalog: { service: {} as never },
      adminAccess: { service: {} as never },
      orderOperations: { service: {} as never },
    })

    try {
      for (const operation of ADMIN_OPERATIONS) {
        const url = operation.path
          .replace('{configurationId}', 'c1')
          .replace('{orderId}', 'o1')
          .replace('{productId}', 'p1')
          .replace('{variantId}', 'v1')
          .replace('{offeringId}', 'f1')
          .concat(operation.path.includes('/reports/') ? '?from=x&to=y' : '')
        for (const method of operation.methods) {
          const response = await app.inject({ method, url, payload: {} })
          expect(`${method} ${operation.path} -> ${response.statusCode}`).toBe(
            `${method} ${operation.path} -> 401`,
          )
        }
      }
    } finally {
      await app.close()
    }
  })
})
