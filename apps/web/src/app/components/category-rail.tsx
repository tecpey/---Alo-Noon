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
 * ## Why the glyph is chosen by code and why there is a fallback
 *
 * The categories are rows in the tenant's own database, not a list in this
 * file: the shop has to be able to add «شیرینی» without a deploy, and the
 * bootstrap's codes (`SANGAK`, `BARBARI`, …) are the stable part. So a code we
 * recognise gets its own bread, and anything else gets a wheat sprig.
 *
 * That fallback is not a nicety. Without it, the first category an operator
 * adds next spring renders as an empty circle — or worse, as whichever bread
 * happened to be first in the list, which would be a picture of the wrong
 * loaf under the right name.
 */
const CATEGORY_GLYPHS: Readonly<Record<string, (props: IconProps) => React.JSX.Element>> = {
  [ALL_CATEGORIES]: GridIcon,
  SPECIAL: OvenIcon,
  SANGAK: SangakIcon,
  BARBARI: BarbariIcon,
  LAVASH: LavashIcon,
  TAFTOON: TaftoonIcon,
  SWEET: KomajIcon,
}

export function CategoryRail({ chips }: { chips: readonly CatalogChip[] }) {
  const { category, selectCategory } = useStorefront()
  if (chips.length === 0) return null

  return (
    <div className="rail">
      <div className="rail__track" role="group" aria-label="دسته‌بندی نان‌ها">
        {chips.map((entry) => {
          const active = entry.code === category
          const Glyph = CATEGORY_GLYPHS[entry.code] ?? WheatIcon
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
