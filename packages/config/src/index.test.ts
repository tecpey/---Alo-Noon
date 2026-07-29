import { describe, expect, it } from 'vitest'

import { validateEnv } from './index'

describe('environment configuration', () => {
  it('applies safe local defaults', () => {
    const result = validateEnv({})

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.API_PORT).toBe(3001)
  })

  it('requires non-default authentication secrets in production', () => {
    const missing = validateEnv({ NODE_ENV: 'production' })
    expect(missing.success).toBe(false)

    const configured = validateEnv({
      NODE_ENV: 'production',
      AUTH_OTP_PEPPER: 'o'.repeat(32),
      AUTH_SESSION_PEPPER: 's'.repeat(32),
    })
    expect(configured.success).toBe(true)
  })
})
