'use client'

import { useEffect, useRef } from 'react'

import { useStorefront } from './storefront-state'
import { CloseIcon, PinIcon } from './icons'
import { selectCityAction } from '../../lib/shop-actions'

/**
 * Changing which city's shop this is, after the first choice.
 *
 * The city was askable exactly once. `CitySwitch` renders only in the
 * `choose-city` state, so the moment a customer picked one there was no control
 * anywhere that could change it — and the pin in the header, which is where
 * anyone would look, was a button with no handler showing a hard-coded «شهرتان
 * را انتخاب کنید» to somebody already shopping in Babol.
 *
 * That is worse than a missing feature. The city is not a preference: it
 * decides which bakeries exist, what the prices are and whether an address can
 * be delivered to at all. Somebody who tapped the wrong one, or who moved, had
 * a shop that would never again show them bread they could buy, and nothing on
 * the screen to do about it.
 *
 * Each city is its own form posting a server action, exactly as `CitySwitch`
 * does — same reasoning: a handful of cities, one tap each, and it works with
 * JavaScript off. The sheet is the wrapper, not a new way of choosing.
 */
export function CitySheet() {
  const { cities, cityNameFa, cityOpen, closeCity } = useStorefront()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!cityOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCity()
    }
    window.addEventListener('keydown', onKey)
    // Focus moves in, or a keyboard user is left tabbing through the shop
    // behind a sheet they cannot see they are inside.
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [cityOpen, closeCity])

  // Nothing to choose between is not a sheet worth opening. One city is the
  // normal state of this shop today, and the header knows not to offer it.
  if (cities.length === 0) return null

  return (
    <div className={`drawer${cityOpen ? ' drawer--open' : ''}`} aria-hidden={!cityOpen}>
      <button
        type="button"
        className="drawer__scrim"
        onClick={closeCity}
        tabIndex={cityOpen ? 0 : -1}
        aria-label="بستن انتخاب شهر"
      />

      <div
        className="drawer__panel city-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="انتخاب شهر"
        tabIndex={-1}
        ref={panel}
      >
        <header className="drawer__head">
          <h2>شهر تحویل</h2>
          <button type="button" className="drawer__close" onClick={closeCity}>
            <CloseIcon width={16} height={16} />
            <span>بستن</span>
          </button>
        </header>

        <p className="city-sheet__note">
          نان‌ها، قیمت‌ها و زمان تحویل برای هر شهر جداگانه تعیین می‌شود.
        </p>

        <div className="city-sheet__options">
          {cities.map((city) => {
            const current = city.nameFa === cityNameFa
            return (
              <form key={city.id} action={selectCityAction}>
                <input type="hidden" name="cityId" value={city.id} />
                <button
                  type="submit"
                  className={`city-sheet__option${current ? ' is-current' : ''}`}
                  aria-current={current ? 'true' : undefined}
                >
                  <PinIcon duotone={current} width={18} height={18} />
                  <span>{city.nameFa}</span>
                </button>
              </form>
            )
          })}
        </div>
      </div>
    </div>
  )
}
