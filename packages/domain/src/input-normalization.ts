/**
 * Turning what someone typed into what the API accepts.
 *
 * Shared because both the customer app and the courier app take the same two
 * inputs — a mobile number and a six-digit code — from the same keyboards. An
 * Iranian phone keyboard produces Persian digits by default, and a number
 * pasted from a contact card arrives as `0912...`, `+98912...`, `0098912...`,
 * or with spaces and dashes through it. Every one of those is the same person's
 * number, and a sign-in screen that refused four of the five forms would be
 * refusing people who typed their own number correctly.
 *
 * Deliberately lenient about *shape* and strict about *identity*: it will not
 * guess at a number that is not an Iranian mobile. `normalizeIranianMobile`
 * elsewhere in this package is the strict, throwing form used server-side once
 * a value has already been normalised — this is the one that faces a keyboard.
 */
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** Persian and Arabic-Indic digits to ASCII; everything else untouched. */
export function normalizeDigits(value: string): string {
  return [...value]
    .map((character) => {
      const persianIndex = PERSIAN_DIGITS.indexOf(character)
      if (persianIndex >= 0) return String(persianIndex)
      const arabicIndex = ARABIC_DIGITS.indexOf(character)
      return arabicIndex >= 0 ? String(arabicIndex) : character
    })
    .join('')
}

/**
 * An Iranian mobile in E.164, or null when what was typed is not one.
 *
 * Null rather than a throw because this runs on every keystroke of a sign-in
 * field, where "not yet a valid number" is the normal state rather than an
 * error worth reporting.
 */
export function parseIranianMobile(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/[\s()-]/g, '')

  if (/^09\d{9}$/.test(ascii)) return `+98${ascii.slice(1)}`
  if (/^9\d{9}$/.test(ascii)) return `+98${ascii}`
  if (/^\+989\d{9}$/.test(ascii)) return ascii
  if (/^00989\d{9}$/.test(ascii)) return `+${ascii.slice(2)}`
  return null
}

/** The six digits of a one-time code, or null if that is not what was typed. */
export function parseOtpCode(value: string): string | null {
  const ascii = normalizeDigits(value).replace(/\s/g, '')
  return /^\d{6}$/.test(ascii) ? ascii : null
}

/**
 * Letters that are the same letter to a reader and different codepoints to a
 * computer.
 *
 * This is the whole reason Persian search fails in most Iranian apps. The
 * letters Persian and Arabic share have separate Unicode codepoints, and which
 * one a customer produces depends on their keyboard rather than on what they
 * meant:
 *
 *   - **ی / ي** — Persian yeh is U+06CC, Arabic yeh is U+064A. The stock iOS
 *     Arabic keyboard, and a great many Android ones, emit the Arabic form. So
 *     somebody typing «نان بربري» is typing the same word as «نان بربری» and
 *     would be told the shop has no such bread.
 *   - **ک / ك** — the same story for kaf. «سنگك» must find «سنگک».
 *   - **ه / ة** — a teh marbuta at the end of a word, which Arabic keyboards
 *     produce and Persian never uses.
 *   - **ا / أ إ آ ٱ** — alef with any of its hamzas, which appear in words
 *     borrowed from Arabic and are dropped in casual typing.
 *   - **و / ؤ**, **ی / ئ** — the same, mid-word.
 *
 * Harakat (the short-vowel marks) are removed outright: they are invisible to
 * most readers, almost never typed, and occasionally pasted in from a copied
 * name. Tatweel — the decorative stretching character — goes for the same
 * reason.
 *
 * ## Why this is a table of numbers
 *
 * Not a stylistic preference. As a literal character class this table is
 * unreviewable: the whole point of these pairs is that they look identical, so
 * `[يىئ]` is three characters nobody can tell apart from their replacement, and
 * a reviewer has no way to judge whether a row is right. Escapes do not survive
 * either — the formatter rewrites `ي` back to the bare letter on every
 * run. Codepoints are the only form that stays put and says what it means.
 */
const FOLDING_RULES: ReadonlyArray<{
  readonly from: readonly number[]
  readonly to: number | ''
  readonly note: string
}> = Object.freeze([
  { from: [0x064a, 0x0649, 0x0626], to: 0x06cc, note: 'Arabic yeh, alef maksura, yeh hamza → ی' },
  { from: [0x0643], to: 0x06a9, note: 'Arabic kaf → ک' },
  { from: [0x0623, 0x0625, 0x0622, 0x0671, 0x0621], to: 0x0627, note: 'alef with any hamza → ا' },
  { from: [0x0624], to: 0x0648, note: 'waw hamza → و' },
  { from: [0x0629], to: 0x0647, note: 'teh marbuta → ه' },
  {
    from: [
      0x064b,
      0x064c,
      0x064d,
      0x064e,
      0x064f,
      0x0650,
      0x0651,
      0x0652,
      0x0670,
      0x0640, // tatweel, the decorative stretch
    ],
    to: '',
    note: 'harakat and tatweel, dropped entirely',
  },
])

const LETTER_FOLDING: ReadonlyArray<readonly [RegExp, string]> = Object.freeze(
  FOLDING_RULES.map(
    (rule) =>
      [
        new RegExp(`[${rule.from.map((code) => String.fromCodePoint(code)).join('')}]`, 'g'),
        rule.to === '' ? '' : String.fromCodePoint(rule.to),
      ] as const,
  ),
)

/**
 * Everything that counts as a word break: ordinary whitespace, the half-space
 * Persian compounds are written with (ZWNJ), its joining twin, and the bidi
 * control characters that ride along with text pasted out of a browser.
 *
 * Codepoints for a stronger reason than the table above — every character here
 * is *invisible*. As a literal class this is a regex whose contents cannot be
 * seen at all, in any editor, by anybody.
 */
const WORD_BREAK_CODES = [
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f, // zero-width space, ZWNJ, ZWJ, LRM, RLM
  0x061c, // Arabic letter mark
  0x2066,
  0x2067,
  0x2068,
  0x2069, // the isolate controls
] as const

const WORD_BREAKS = new RegExp(
  `[\\s${WORD_BREAK_CODES.map((code) => String.fromCodePoint(code)).join('')}]+`,
  'g',
)

/**
 * What someone typed, reduced to what they meant, for matching text against
 * text.
 *
 * Used for searching a catalogue, and for nothing that is stored: the fold is
 * lossy on purpose — «ائتلاف» and «اتلاف» collapse together — which is right
 * for deciding whether to show somebody a loaf and wrong for a name on an
 * invoice.
 *
 * The space handling is the other half of the problem. Persian compounds are
 * written with a half-space (ZWNJ, U+200C): «نان‌های». A customer typing on a
 * phone keyboard usually produces an ordinary space instead, or nothing at all,
 * and all three are the same word. Every run of space-ish characters therefore
 * collapses to one space, and the caller is free to strip spaces entirely when
 * it wants «نان سنگک» to match «نان‌سنگک».
 */
export function foldPersian(value: string): string {
  let folded = normalizeDigits(value)
  for (const [pattern, replacement] of LETTER_FOLDING) {
    folded = folded.replace(pattern, replacement)
  }
  return folded.toLowerCase().replace(WORD_BREAKS, ' ').trim()
}

/**
 * Whether a catalogue entry answers what somebody typed.
 *
 * Every word of the query has to appear somewhere in the text, in any order:
 * «سنگک تازه» finds «نان سنگک تازه» and «تازه سنگک» finds it too, because
 * somebody searching for bread is listing attributes rather than quoting a
 * name. Requiring the phrase in order would fail the more natural of the two.
 *
 * An empty query matches everything, which is what an empty search box means.
 */
export function matchesPersianQuery(text: string, query: string): boolean {
  const words = foldPersian(query).split(' ').filter(Boolean)
  if (words.length === 0) return true
  const haystack = foldPersian(text)
  // Also matched without spaces, so «نان سنگک» finds «نان‌سنگک» — the same
  // compound written with a half-space, which is how a bakery would write it.
  const joined = haystack.replace(/ /g, '')
  return words.every((word) => haystack.includes(word) || joined.includes(word.replace(/ /g, '')))
}
