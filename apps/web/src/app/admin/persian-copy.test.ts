import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The operator panels, in the language the operators speak.
 *
 * The repository's own policy is Persian-first for user-facing interfaces, and
 * the panel mostly is — but English leaks in from the places the code thinks in
 * English. `tenant` is the word that got through: it appeared in a page
 * subtitle, in a scope column repeated on every row, and in a role description,
 * on the screen where somebody decides who is allowed to move money.
 *
 * It is an easy leak to reintroduce, because it reads perfectly to whoever is
 * writing the code. So it is checked rather than remembered.
 */
const PANELS = [new URL('.', import.meta.url), new URL('../bakery/', import.meta.url)]

/**
 * Words that belong to the implementation and not to a screen.
 *
 * Deliberately short. This is not a spell-checker for English — plenty of
 * English is legitimate here, from an account code to a provider's brand name —
 * it is a list of the specific words that have leaked or would read as jargon
 * to somebody running a bakery.
 */
const JARGON = ['tenant', 'idempotency', 'payload', 'nullable', 'enum', 'boolean']

/** Persian text with the code stripped out, which is all this should judge. */
function persianProse(source: string): string[] {
  return [...source.matchAll(/'([^']*[؀-ۿ][^']*)'|`([^`]*[؀-ۿ][^`]*)`|>([^<>{}]*[؀-ۿ][^<>{}]*)</g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(Boolean)
}

function panelSources(): { file: string; source: string }[] {
  return PANELS.flatMap((directory) =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'),
      )
      .map((entry) => {
        const file = `${entry.parentPath}/${entry.name}`
        return { file, source: readFileSync(file, 'utf8') }
      }),
  )
}

describe('what the panels say out loud', () => {
  const sources = panelSources()

  it('reads the panel source at all, or this test proves nothing', () => {
    // A glob that silently matches nothing is a test that passes forever.
    expect(sources.length).toBeGreaterThan(10)
    expect(sources.some(({ source }) => /[؀-ۿ]/.test(source))).toBe(true)
  })

  it.each(JARGON)('never says «%s» inside a Persian sentence', (word) => {
    const offenders: string[] = []
    for (const { file, source } of sources) {
      for (const sentence of persianProse(source)) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(sentence)) {
          offenders.push(`${file.split('/app/')[1]}: ${sentence.trim().slice(0, 70)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A count rendered straight from a number arrives in Latin digits, next to
   * money and dates that are Persian. It looks like a rendering fault, and on
   * the dispatch board — where it says how many orders a courier is already
   * carrying — it is the number a decision is made on.
   */
  it('never drops a raw number into a Persian sentence', () => {
    const offenders: string[] = []
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/`[^`]*\$\{([^}]+)\}[^`]*[؀-ۿ][^`]*`/g)) {
        const expression = match[1] ?? ''
        // A formatter, a label lookup, or plainly a string: all fine.
        if (
          /format|toPersianDigits|toLocaleString|label\(|Fa\b|name|Name|sku|code|Id\b/.test(
            expression,
          )
        ) {
          continue
        }
        offenders.push(`${file.split('/app/')[1]}: \${${expression}}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
