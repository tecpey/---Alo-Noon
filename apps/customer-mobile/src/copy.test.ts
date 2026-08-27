import { describe, expect, it } from 'vitest'

import { customerCopy } from './copy'

describe('customer app copy', () => {
  it('is Persian-first', () => expect(customerCopy.title).toContain('نان'))

  it('spells the brand the way the wordmark spells it', () => {
    // The logo is the authority on the brand's own name. An app whose header
    // and whose sign disagree about it has two names.
    expect(customerCopy.brandName).toBe('الو نون')
  })
})
