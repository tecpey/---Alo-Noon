import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ORDER_CODE_LENGTH, generateOrderCode, isOrderCode } from '@alo-noon/domain'

/**
 * The check constraint and the generator, made to agree.
 *
 * They are written in two languages in two packages: a PostgreSQL regex in a
 * migration, and TypeScript in the domain. Nothing but this connects them, and
 * a disagreement is silent in both directions — a regex stricter than the
 * generator refuses orders the platform is trying to place, and a looser one
 * lets back in exactly the unreadable machine string the constraint exists to
 * keep out.
 *
 * Here rather than in `packages/database`, which deliberately does not depend
 * on the domain; this application already depends on both, so it is the layer
 * that can honestly compare them.
 */
const migration = readFileSync(
  new URL(
    '../../../packages/database/prisma/migrations/20260909100000_order_code_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

const CHECK_PATTERN = /CHECK \("publicId" ~ '(\^\[[^']+\]\{8\}\$)'\)/.exec(migration)?.[1]

describe('the database check and the order-code generator', () => {
  it('found the constraint to compare against', () => {
    // A regex that silently matched nothing would make every assertion below
    // pass for the wrong reason.
    expect(CHECK_PATTERN).toBeDefined()
    expect(CHECK_PATTERN).toContain(`{${ORDER_CODE_LENGTH}}`)
  })

  it('accepts every code the domain can generate', () => {
    const pattern = new RegExp(CHECK_PATTERN!)
    // Enough draws that every symbol of a thirty-two character alphabet turns
    // up in all eight positions many times over.
    for (let draw = 0; draw < 3_000; draw += 1) {
      const code = generateOrderCode((length) => randomBytes(length))
      expect(`${code}: ${pattern.test(code)}`).toBe(`${code}: true`)
      // And the domain's own recogniser agrees, so all three say the same thing.
      expect(isOrderCode(code)).toBe(true)
    }
  })

  it('refuses everything the domain would refuse', () => {
    const pattern = new RegExp(CHECK_PATTERN!)
    for (const rejected of [
      'cmttm7si2000dijbb69ytrb7n', // the cuid the dropped default produced
      'BFCA059D-1', // a hand-made fixture code, with a dash
      'ABCDEFGI', // the four symbols the alphabet leaves out, so that
      'ABCDEFGL', // nothing in a code read down a phone can be misheard
      'ABCDEFGO',
      'ABCDEFGU',
      'abcdefgh', // lower case: the alphabet is upper
      'ABCDEFG', // too short
      'ABCDEFGHJ', // too long
      '', // nothing at all
    ]) {
      expect(`${rejected || '(empty)'}: ${pattern.test(rejected)}`).toBe(
        `${rejected || '(empty)'}: false`,
      )
      expect(isOrderCode(rejected)).toBe(false)
    }
  })
})
