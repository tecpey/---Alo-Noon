import { describe, expect, it } from 'vitest'

import { Prisma } from './index'

describe('database package', () => {
  it('exports the generated Prisma namespace', () => {
    expect(Prisma.prismaVersion.client).toMatch(/^5\./)
  })
})
