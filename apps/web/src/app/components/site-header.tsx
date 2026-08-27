import Link from 'next/link'

import { BrandMark } from './brand-mark'
import { CartIcon, PinIcon, SearchIcon, UserIcon } from './icons'
import { brandCopy, orderConditions } from '../../lib/storefront-content'
import { toPersianDigits } from '../../lib/persian'

/**
 * The top bar: who we are, where you are, what you are looking for, and what
 * you have picked so far.
 *
 * The delivery address sits in the bar rather than at checkout because in this
 * business it is not a shipping detail — it decides which bakeries exist for
 * this customer at all. A basket filled from a bakery that cannot reach you is
 * a basket that has to be emptied.
 */
export function SiteHeader({ basketCount }: { basketCount: number }) {
  const address = orderConditions.find((condition) => condition.id === 'address')

  return (
    <header className="site-header">
      <Link className="site-header__brand" href="/" aria-label={brandCopy.nameFa}>
        <BrandMark />
      </Link>

      <div className="site-header__controls">
        <button type="button" className="an-pill site-header__address">
          <PinIcon />
          <span>{address?.valueFa}</span>
        </button>

        <div className="site-header__search">
          <SearchIcon />
          <input
            type="search"
            placeholder={brandCopy.searchPlaceholderFa}
            aria-label={brandCopy.searchPlaceholderFa}
          />
        </div>
      </div>

      <div className="site-header__account">
        <a className="site-header__link" href="/account">
          <UserIcon />
          <span>{brandCopy.accountFa}</span>
        </a>
        <a className="site-header__link site-header__basket" href="/basket">
          <span className="site-header__count" aria-hidden="true">
            {toPersianDigits(String(basketCount))}
          </span>
          <CartIcon />
          <span>{brandCopy.basketFa}</span>
          <span className="visually-hidden">{toPersianDigits(String(basketCount))} کالا</span>
        </a>
      </div>
    </header>
  )
}
