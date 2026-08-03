import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const openApi = readFileSync(
  new URL('../../../packages/contracts/openapi/alo-noon.v1.yaml', import.meta.url),
  'utf8',
)
const otpRequestPath = openApi
  .split('  /api/v1/auth/otp/request:')[1]
  ?.split('  /api/v1/auth/otp/verify:')[0]
const otpVerifyPath = openApi
  .split('  /api/v1/auth/otp/verify:')[1]
  ?.split('  /api/v1/auth/session:')[0]

describe('authentication delivery OpenAPI parity', () => {
  it('requires the same idempotency and Iranian mobile boundaries as Zod', () => {
    expect(openApi).toContain('name: Idempotency-Key')
    expect(openApi).toContain('minLength: 16')
    expect(openApi).toContain("pattern: '^\\+989\\d{9}$'")
  })

  it('documents generic anti-enumeration outcomes without provider internals', () => {
    expect(openApi).toContain('Responses never disclose whether the mobile number')
    expect(openApi).toContain('Delivery may be suppressed by a private abuse decision')
    expect(openApi).toContain("'409':")
    expect(openApi).toContain("'503':")
    expect(otpRequestPath).toBeDefined()
    expect(otpRequestPath).not.toMatch(/providerReference|credentialReference|rawOtp|apiKey/)
    expect(otpVerifyPath).toContain("'503':")
  })
})
