import { describe, expect, it } from 'vitest'

import { validateEnv } from './index'

describe('environment configuration', () => {
  it('applies safe local defaults', () => {
    const result = validateEnv({})

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.API_PORT).toBe(3001)
  })
})
