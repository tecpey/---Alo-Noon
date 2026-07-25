import { describe, expect, it } from 'vitest'

import { foundationStatus } from './page'

describe('landing page', () => {
  it('exposes the foundation status in Persian', () => {
    expect(foundationStatus).toContain('آماده')
  })
})
