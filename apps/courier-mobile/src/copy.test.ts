import { describe, expect, it } from 'vitest'

import { courierCopy } from './copy'

describe('courier app copy', () => {
  it('describes delivery work', () => expect(courierCopy.subtitle).toContain('تحویل'))
})
