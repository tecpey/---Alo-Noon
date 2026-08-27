import type { ActiveCitySummary } from '@alo-noon/contracts'

import { PinIcon } from './icons'
import { selectCityAction } from '../../lib/shop-actions'

/**
 * Choosing which city's shop this is.
 *
 * One form per city, each a submit button, rather than a select with a submit
 * beside it. There are a handful of cities and the choice is the whole point of
 * the screen, so making it one tap instead of three is worth the markup — and it
 * works with JavaScript disabled, which a `<select onChange>` would not.
 */
export function CitySwitch({ cities }: { cities: readonly ActiveCitySummary[] }) {
  return (
    <div className="city-switch">
      {cities.map((city) => (
        <form key={city.id} action={selectCityAction}>
          <input type="hidden" name="cityId" value={city.id} />
          <button type="submit" className="an-button an-button--quiet city-switch__option">
            <PinIcon width={18} height={18} />
            {city.nameFa}
          </button>
        </form>
      ))}
    </div>
  )
}
