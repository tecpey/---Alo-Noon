'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { BrandMark } from './brand-mark'
import { useStorefront } from './storefront-state'
import { CartIcon, CloseIcon, PinIcon, SearchIcon, UserIcon } from './icons'
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
 *
 * It is pinned, and it is glass. Both for the same reason: the two facts a
 * customer needs while scrolling a page of bread are where it is going and what
 * they have already chosen. A bar that scrolls away takes both with it, and a
 * solid bar pinned over a page of photographs cuts the page in half. Glass
 * keeps it legible while letting the bread pass underneath it.
 */
export function SiteHeader() {
  const address = orderConditions.find((condition) => condition.id === 'address')
  const { count, pulse, openDrawer, query, setQuery } = useStorefront()
  const [condensed, setCondensed] = useState(false)
  const [bumping, setBumping] = useState(false)
  const firstPulse = useRef(pulse)

  useEffect(() => {
    // Threshold rather than any-scroll: a bar that changes state on the first
    // pixel flickers under a trackpad.
    const onScroll = () => setCondensed(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (pulse === firstPulse.current) return
    setBumping(true)
    const timer = window.setTimeout(() => setBumping(false), 420)
    return () => window.clearTimeout(timer)
  }, [pulse])

  return (
    <header className={`site-header${condensed ? ' site-header--condensed' : ''}`}>
      <div className="site-header__inner">
        <Link className="site-header__brand" href="/" aria-label={brandCopy.nameFa}>
          <BrandMark />
        </Link>

        <div className="site-header__controls">
          <button type="button" className="an-pill site-header__address">
            <PinIcon duotone />
            <span>{address?.valueFa}</span>
          </button>

          {/*
            It filters. It used to be an input with a placeholder and no
            handler — a box that invited typing and swallowed it, which is the
            same defect the category chips and the delivery conditions each had
            before they were fixed, and the worst of the three because a
            customer who types a bread's name and gets nothing concludes the
            shop does not stock it.

            No submit and no results page: the shelves below are already on
            screen and they narrow as the letters arrive. A search that needs a
            round trip to say «نان سنگک» is on the shelf you are looking at is a
            search that takes longer than scrolling.
          */}
          <div className="site-header__search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={brandCopy.searchPlaceholderFa}
              aria-label={brandCopy.searchPlaceholderFa}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="site-header__search-clear"
                onClick={() => setQuery('')}
                aria-label="پاک کردن جست‌وجو"
              >
                <CloseIcon width={14} height={14} />
              </button>
            )}
          </div>
        </div>

        <div className="site-header__account">
          <Link className="site-header__link" href="/account">
            <UserIcon />
            <span>{brandCopy.accountFa}</span>
          </Link>
          {/* A button, not a link: the basket opens over the shop rather than
              navigating away from it — and a link to a route that does not
              exist was two prefetch 404s on every page load. */}
          <button
            type="button"
            className={`site-header__link site-header__basket${bumping ? ' is-bumping' : ''}`}
            onClick={openDrawer}
          >
            {count > 0 && (
              <span className="site-header__count" aria-hidden="true">
                {toPersianDigits(String(count))}
              </span>
            )}
            <CartIcon duotone={count > 0} />
            <span>{brandCopy.basketFa}</span>
            <span className="visually-hidden">
              {count > 0 ? `${toPersianDigits(String(count))} کالا در سبد` : 'سبد خالی است'}
            </span>
          </button>
        </div>
      </div>
    </header>
  )
}
