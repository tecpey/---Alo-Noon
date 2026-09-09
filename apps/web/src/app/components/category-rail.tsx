'use client'

import { useStorefront } from './storefront-state'
import type { CatalogChip } from '../../lib/catalog-view'

/**
 * The category chips, which actually filter.
 *
 * They were `role="tab"` and changed nothing, which is worse than having no
 * filter at all: a control that looks like it works and does not is a control a
 * customer stops believing, and then stops using elsewhere on the page. They
 * are toggle buttons now, they carry `aria-pressed`, and the shelves below read
 * the same state.
 *
 * The chips are the categories the shop's own catalog rows carry, not a list
 * written here. A chip that filters to nothing cannot exist, because a category
 * with nothing on sale never produces one.
 *
 * A rail rather than a wrapped block: on a phone the second row of a wrapped
 * filter is the row nobody scrolls to, and an overflowing rail says so by
 * showing a chip half-cut at the edge.
 */
export function CategoryRail({ chips }: { chips: readonly CatalogChip[] }) {
  const { category, selectCategory } = useStorefront()
  if (chips.length === 0) return null

  return (
    <div className="rail">
      <div className="rail__track" role="group" aria-label="دسته‌بندی نان‌ها">
        {chips.map((entry) => {
          const active = entry.code === category
          return (
            <button
              key={entry.code}
              type="button"
              aria-pressed={active}
              className={`chip${active ? ' chip--active' : ''}`}
              onClick={() => selectCategory(entry.code)}
            >
              {entry.labelFa}
            </button>
          )
        })}
      </div>
    </div>
  )
}
