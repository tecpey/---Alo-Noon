import {
  PLACE_SEARCH_MAX_RESULTS,
  PLACE_SEARCH_MAX_TERM_LENGTH,
  PLACE_SEARCH_MIN_TERM_LENGTH,
} from '@alo-noon/domain'
import {
  PLACE_SEARCH_MAX_TERM,
  PLACE_SEARCH_MIN_TERM,
  PLACE_SEARCH_RESULT_LIMIT,
  placeSearchQuerySchema,
} from '@alo-noon/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Two copies of three numbers, and the reason they are allowed to be two copies.
 *
 * The contracts package depends on nothing but zod — deliberately, so that a
 * client generated from it carries no rules engine — which means it cannot
 * import the domain constants and has to restate them. Restated constants drift;
 * this is the only thing standing between them and a silent disagreement.
 *
 * The disagreement would not be loud, which is why it is worth a test. If the
 * edge accepted a two-character term the provider's floor rejects, every such
 * search would spend a paid call to return nothing, and the customer would read
 * it as "that street does not exist". If the edge capped results below what the
 * adapter returns, the extras would be dropped after being paid for. Both look
 * like the search merely being poor.
 *
 * This package is where the check goes because it is the only one that depends
 * on both.
 */
describe('the search rules the edge enforces', () => {
  it('are the same numbers the provider side works to', () => {
    expect(PLACE_SEARCH_MIN_TERM).toBe(PLACE_SEARCH_MIN_TERM_LENGTH)
    expect(PLACE_SEARCH_MAX_TERM).toBe(PLACE_SEARCH_MAX_TERM_LENGTH)
    expect(PLACE_SEARCH_RESULT_LIMIT).toBe(PLACE_SEARCH_MAX_RESULTS)
  })

  it('are the numbers the schema actually applies, not just ones declared near it', () => {
    // A constant exported beside a schema that hardcodes something else would
    // satisfy the assertion above and none of the intent behind it.
    const short = 'ا'.repeat(PLACE_SEARCH_MIN_TERM_LENGTH - 1)
    const long = 'ا'.repeat(PLACE_SEARCH_MAX_TERM_LENGTH + 1)
    expect(placeSearchQuerySchema.safeParse({ term: short }).success).toBe(false)
    expect(placeSearchQuerySchema.safeParse({ term: long }).success).toBe(false)
    expect(
      placeSearchQuerySchema.safeParse({ term: 'ا'.repeat(PLACE_SEARCH_MIN_TERM_LENGTH) }).success,
    ).toBe(true)
  })

  it('trims before measuring, so spaces cannot buy a shorter term', () => {
    // `.trim()` runs before `.min()` in the chain. Without it, "  ا  " is four
    // characters to zod and one to the provider, and the call is wasted.
    expect(placeSearchQuerySchema.safeParse({ term: '  ا  ' }).success).toBe(false)
  })
})
