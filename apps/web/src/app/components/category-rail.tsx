'use client'

import { useStorefront } from './storefront-state'
import {
  BarbariIcon,
  GridIcon,
  KomajIcon,
  LavashIcon,
  OvenIcon,
  SangakIcon,
  TaftoonIcon,
  WheatIcon,
  type IconProps,
} from './icons'
import { foldPersian } from '@alo-noon/domain'
import { ALL_CATEGORIES, type CatalogChip } from '../../lib/catalog-view'

/**
 * The categories, as tiles you can see rather than words you have to read.
 *
 * They were text chips, which is what a filter looks like on a desktop table.
 * On a phone, held one-handed, a row of six Persian words at 13px is six things
 * to read before choosing one — and the choice is between kinds of bread, which
 * is a thing people recognise by shape long before they read its name. A picture
 * of a sangak is faster than the word «سنگک» for the same reason a road sign is
 * faster than a sentence.
 *
 * They still filter, and they still carry `aria-pressed`: this is the same
 * control it was, wearing the right clothes. Before that fix they were
 * `role="tab"` and changed nothing, which is a lesson worth not repeating — a
 * prettier control that does nothing is a worse control.
 *
 * ## Why the glyph is chosen by name and not by code
 *
 * The obvious key is the category's code, and it is the wrong one.
 * `ProductCategory.code` is unique across the *whole table* rather than per
 * tenant, so the first shop to claim `SANGAK` owns it and every shop after
 * has to invent something else — which is exactly what the existing fixtures
 * do, carrying codes like `TRAD-145D7F`. A map keyed on bare codes would
 * therefore match the first tenant and silently fall back for all the rest.
 *
 * So the glyph is chosen from the name, folded with the same helper the search
 * box uses: an operator who calls a category «سنگک» or «نان سنگک» gets a
 * sangak without knowing any code convention, and «سنگك» typed on an Arabic
 * keyboard lands too. Matching the picture to the word the customer reads is
 * also simply the right relationship — the code is an internal handle and
 * nobody sees it.
 *
 * Anything unrecognised gets a wheat sprig. That fallback is not a nicety:
 * without it the first category an operator adds next spring renders as an
 * empty circle, or as whichever bread happened to be first in the list, which
 * would be a picture of the wrong loaf under the right name.
 */
const BREAD_GLYPHS: ReadonlyArray<
  readonly [readonly string[], (props: IconProps) => React.JSX.Element]
> = [
  // Order matters: «نان سنگک کنجدی» must not be caught by a looser rule first.
  [['سنگک'], SangakIcon],
  [['بربری'], BarbariIcon],
  [['لواش'], LavashIcon],
  [['تافتون', 'تافتان'], TaftoonIcon],
  [['کماج', 'شیرینی'], KomajIcon],
  [['ویژه', 'پخت'], OvenIcon],
]

function glyphFor(chip: CatalogChip): (props: IconProps) => React.JSX.Element {
  if (chip.code === ALL_CATEGORIES) return GridIcon
  const name = foldPersian(chip.labelFa)
  for (const [words, Glyph] of BREAD_GLYPHS) {
    if (words.some((word) => name.includes(foldPersian(word)))) return Glyph
  }
  return WheatIcon
}

export function CategoryRail({ chips }: { chips: readonly CatalogChip[] }) {
  const { category, selectCategory } = useStorefront()
  if (chips.length === 0) return null

  return (
    <div className="rail">
      <div className="rail__track" role="group" aria-label="دسته‌بندی نان‌ها">
        {chips.map((entry) => {
          const active = entry.code === category
          const Glyph = glyphFor(entry)
          return (
            <button
              key={entry.code}
              type="button"
              aria-pressed={active}
              className={`category${active ? ' category--active' : ''}`}
              onClick={() => selectCategory(entry.code)}
            >
              <span className="category__tile" aria-hidden="true">
                <Glyph duotone={active} width={28} height={28} />
              </span>
              <span className="category__label">{entry.labelFa}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
