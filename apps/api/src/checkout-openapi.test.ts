import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const openApi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)

describe('Phase 2E OpenAPI parity', () => {
  it.each([
    '/api/v1/addresses:',
    '/api/v1/serviceability/check:',
    '/api/v1/cart/quote:',
    '/api/v1/orders:',
  ])('publishes %s', (path) => expect(openApi).toContain(path))

  it('documents only authoritative checkout command fields', () => {
    expect(openApi).toContain('required: [deliveryAddressId, expectedCartVersion, idempotencyKey]')
    expect(openApi).toContain('required: [quoteId, idempotencyKey]')
    expect(openApi).toContain('deliveryDistanceMeters: { type: integer, minimum: 0 }')
    expect(openApi).toContain('bakery capacity')
  })
})
