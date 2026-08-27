'use client'

import { useStorefront } from './storefront-state'
import { categories } from '../../lib/storefront-content'

/**
 * The category chips, which actually filter.
 *
 * They were `role="tab"` and changed nothing, which is worse than having no
 * filter at all: a control that looks like it works and does not is a control a
 * customer stops believing, and then stops using elsewhere on the page. They
 * are toggle buttons now, they carry `aria-pressed`, and the shelves below read
 * the same state.
 *
 * A rail rather than a wrapped block: on a phone the second row of a wrapped
 * filter is the row nobody scrolls to, and an overflowing rail says so by
 * showing a chip half-cut at the edge.
 */
export function CategoryRail() {
  const { category, selectCategory } = useStorefront()

  return (
    <div className="rail">
      <div className="rail__track" role="group" aria-label="دسته‌بندی نان‌ها">
        {categories.map((entry) => {
          const active = entry.id === category
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              className={`chip${active ? ' chip--active' : ''}`}
              onClick={() => selectCategory(entry.id)}
            >
              {entry.labelFa}
            </button>
          )
        })}
      </div>
    </div>
  )
}
