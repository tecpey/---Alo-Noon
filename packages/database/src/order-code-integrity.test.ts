import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The migration that made the order code the only thing an order can be called.
 *
 * Shape only. Whether the check agrees with the generator that produces these
 * codes is asserted in `apps/api`, which is the layer that legitimately sees
 * both this package and the domain — the database package deliberately does not
 * depend on the domain, and a test is not a reason to make it.
 */
const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260909100000_order_code_integrity/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')

const CHECK_PATTERN = /CHECK \("publicId" ~ '(\^\[[^']+\]\{8\}\$)'\)/.exec(migration)?.[1]

describe('the order code, as the database understands it', () => {
  it('drops the default and checks the shape, because either alone leaves half the hole', () => {
    // Dropping the default makes a *missing* code an error. The check makes a
    // *wrong* one an error, which the default never could.
    expect(migration).toContain('ALTER COLUMN "publicId" DROP DEFAULT')
    expect(CHECK_PATTERN).toBeDefined()
  })

  it('rejects the machine string the default used to produce', () => {
    const pattern = new RegExp(CHECK_PATTERN!)
    // A real one, off the dispatch board before this was fixed.
    expect(pattern.test('cmttm7si2000dijbb69ytrb7n')).toBe(false)
    expect(pattern.test('25AB9AD9')).toBe(true)
  })

  it('excludes the symbols that can be misheard, which is the point of the alphabet', () => {
    const pattern = new RegExp(CHECK_PATTERN!)
    // No I, L, O or U: nothing in a code read down a phone should be a
    // candidate for a one or a zero.
    for (const excluded of ['I', 'L', 'O', 'U']) {
      const code = `ABCDEFG${excluded}`
      expect(`${code} rejected`).toBe(`${code} ${pattern.test(code) ? 'accepted' : 'rejected'}`)
    }
    expect(pattern.test('ABCDEFG')).toBe(false)
    expect(pattern.test('ABCDEFGHJ')).toBe(false)
  })

  it('leaves the schema without a default, so a missing code fails to compile', () => {
    // The check catches a wrong code at run time; the absent Prisma default is
    // what turns a *missing* one into a type error. Both, because a constraint
    // violation found at three in the morning is a worse way to learn this
    // than a build.
    const order = /model Order \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? ''
    expect(order).toContain('publicId')
    expect(order).not.toMatch(/publicId[^\n]*@default/)
  })

  it('backfills before it constrains, so it cannot fail on old data', () => {
    // A check added over rows that violate it is a migration that blocks a
    // release on somebody's development database.
    expect(migration.indexOf('UPDATE "Order" SET "publicId"')).toBeLessThan(
      migration.indexOf('ADD CONSTRAINT "Order_publicId_is_order_code"'),
    )
  })

  it('touches nothing but this one column', () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|INDEX)/i)
    expect(migration).not.toMatch(/DELETE\s+FROM/i)
  })
})
