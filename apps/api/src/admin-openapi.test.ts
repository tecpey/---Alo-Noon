import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildApp } from './app'

const openapi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

/**
 * Every documented admin operation, with the method each supports.
 *
 * Spelled out so that documenting an operation the API does not register fails
 * here. The other direction — registering one and forgetting to document it —
 * is caught by `documentsEveryAdminRouteTheApiRegisters` below, which reads the
 * app's own route table. This list used to claim it caught both and did not:
 * a route simply absent from it produced no failure, and seven of them
 * accumulated that way before anybody noticed.
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
  { path: '/api/v1/admin/access/branches', methods: ['GET'] },
  { path: '/api/v1/admin/settlement/outstanding', methods: ['GET'] },
  { path: '/api/v1/admin/settlement/payouts', methods: ['GET', 'POST'] },
  { path: '/api/v1/admin/settlement/payouts/{payoutId}/paid', methods: ['POST'] },
  { path: '/api/v1/admin/withdrawals', methods: ['GET'] },
  { path: '/api/v1/admin/withdrawals/{withdrawalId}/paid', methods: ['POST'] },
  { path: '/api/v1/admin/withdrawals/{withdrawalId}/reject', methods: ['POST'] },
  { path: '/api/v1/admin/routing-providers/configurations', methods: ['GET', 'POST'] },
  {
    path: '/api/v1/admin/routing-providers/configurations/{configurationId}/health',
    methods: ['POST'],
  },
  { path: '/api/v1/admin/email-providers/configurations', methods: ['GET', 'POST'] },
  {
    path: '/api/v1/admin/email-providers/configurations/{configurationId}/health',
    methods: ['POST'],
  },
  { path: '/api/v1/admin/alert-recipients', methods: ['GET', 'POST'] },
  { path: '/api/v1/admin/alert-recipients/{recipientId}/enabled', methods: ['POST'] },
]

/** The contiguous block of admin paths, which the spec keeps together. */
function adminSection(): string {
  const start = openapi.indexOf(`  ${ADMIN_OPERATIONS[0]!.path}:`)
  const end = openapi.indexOf('  /api/v1/serviceability/check:')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return openapi.slice(start, end)
}

/**
 * The app with every admin surface registered and nothing behind them.
 *
 * Services are empty on purpose: an unauthenticated request has to be refused
 * before any of them is reached, so a route that skipped its auth check
 * surfaces as a 500 rather than passing as a 401.
 */
async function buildAdminApp() {
  return buildApp({
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
    adminProviders: {
      paymentProviderService: {} as never,
      authDeliveryProviderService: {} as never,
      routingProviderService: {} as never,
      emailProviderService: {} as never,
    },
    adminReporting: { service: {} as never, financialService: {} as never },
    adminCatalog: { service: {} as never },
    adminAccess: { service: {} as never },
    orderOperations: { service: {} as never },
    partnerSettlement: { service: {} as never },
    walletWithdrawals: { service: {} as never },
  })
}

/**
 * Every `METHOD /path` the app serves, read from Fastify's own route tree.
 *
 * The tree nests: a child appears as `│   ├── /:withdrawalId/paid (POST)` under
 * its parent, so a line-by-line match on the full prefix silently misses every
 * parameterised sub-route — which is exactly the shape most write endpoints
 * have. Indentation is four characters per level, so the ancestors of a line
 * are recoverable and the full path can be rebuilt.
 */
function registeredOperations(tree: string): string[] {
  const segments: string[] = []
  const operations: string[] = []

  for (const line of tree.split('\n')) {
    const connector = line.search(/[├└]── /)
    if (connector < 0) continue
    const depth = connector / 4
    const node = line.slice(connector + 4)
    const methods = node.match(/\s\(([A-Z, ]+)\)\s*$/)
    const segment = (methods ? node.slice(0, methods.index) : node).trim()

    segments.length = depth
    segments[depth] = segment
    if (!methods?.[1]) continue

    // Path parameters print as :name and are documented as {name}.
    const path = segments
      .join('')
      .replace(/:(\w+)/g, '{$1}')
      .replace(/\/$/, '')
    for (const method of methods[1].split(',').map((entry) => entry.trim())) {
      // HEAD is Fastify's own answer to every GET, and OPTIONS is CORS's.
      // Neither is an operation anybody documents.
      if (method === 'HEAD' || method === 'OPTIONS') continue
      operations.push(`${method} ${path}`)
    }
  }
  return operations
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

  /**
   * The other direction, derived rather than listed.
   *
   * A hand-kept list cannot notice what is missing from it. This reads the
   * routes the app actually registers and requires each admin one to appear in
   * the specification — so a new endpoint is documented before it ships, which
   * is the only moment anybody remembers what it does.
   */
  it('documents every admin route the API registers', async () => {
    const app = await buildAdminApp()
    try {
      const registered = registeredOperations(app.printRoutes({ commonPrefix: false }))
      // A guard that found nothing would pass silently, which is the one way
      // this test could be worse than not existing.
      expect(registered.filter((entry) => entry.includes('/admin/')).length).toBeGreaterThan(20)

      const documented = new Set(
        ADMIN_OPERATIONS.flatMap((operation) =>
          operation.methods.map((method) => `${method} ${operation.path}`),
        ),
      )
      const undocumented = registered
        .filter((entry) => entry.includes(' /api/v1/admin/'))
        .filter((entry) => !documented.has(entry))
      expect(undocumented).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('registers every documented admin operation, and gates each one', async () => {
    const app = await buildAdminApp()

    try {
      for (const operation of ADMIN_OPERATIONS) {
        const url = operation.path
          .replace('{configurationId}', 'c1')
          .replace('{orderId}', 'o1')
          .replace('{productId}', 'p1')
          .replace('{variantId}', 'v1')
          .replace('{offeringId}', 'f1')
          .replace('{payoutId}', 'y1')
          .replace('{withdrawalId}', 'w1')
          .replace('{recipientId}', 'r1')
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
