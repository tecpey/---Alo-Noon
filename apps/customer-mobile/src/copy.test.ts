import { describe, expect, it } from 'vitest'

import { customerCopy } from './copy'

describe('customer app copy', () => {
  it('is Persian-first', () => expect(customerCopy.title).toContain('نان'))
})
