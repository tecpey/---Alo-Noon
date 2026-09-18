'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { useStorefrontOptional } from './storefront-state'
import { CartIcon, HomeIcon, ReceiptIcon, UserIcon } from './icons'
import { toPersianDigits } from '../../lib/persian'

/**
 * The four places a customer goes, on the one device most of them are on.
 *
 * Until now the shop, the basket, the orders and the account were reachable
 * only from the pinned bar at the top — which is where a *website* puts them
 * and not where an *app* does. Installed to a home screen, with no browser
 * chrome and a thumb at the bottom of a six-inch phone, the top bar is the
 * furthest point on the screen from the hand holding it.
 *
 * Four, and not five. The wallet is inside the account rather than out here:
 * it is somewhere a customer goes deliberately a few times a month, and a tab
 * spent on it is a tab taken from something used on every visit.
 *
 * ## What each one is
 *
 * The basket is a button rather than a link, because the basket is a drawer
 * that opens over the shop. Sending somebody to a separate page to look at what
 * they have chosen, and then back, is how a customer loses their place in a
 * list of bread. The other three are ordinary links, so they prefetch, and so a
 * long press offers "open in new tab" like anything else.
 *
 * ## Why it is hidden on a wide screen
 *
 * A bar pinned to the bottom of a desktop window is a phone convention wearing
 * the wrong clothes: the top bar is already in reach of a cursor, and the same
 * four destinations twice is a second place to look for one answer. The
 * breakpoint is the same `56.25rem` the rest of the storefront uses to decide
 * it is no longer on a phone.
 */

const TABS = [
  { id: 'home', href: '/', labelFa: 'خانه', Icon: HomeIcon },
  { id: 'orders', href: '/orders', labelFa: 'سفارش‌ها', Icon: ReceiptIcon },
  { id: 'account', href: '/account', labelFa: 'پروفایل', Icon: UserIcon },
] as const

/**
 * Panels are tools somebody is given, not a shop they browse. A customer tab
 * bar under an admin table would be four links out of the job they are doing.
 */
const HIDDEN_PREFIXES = ['/admin', '/bakery', '/payments', '/checkout', '/legal']

export function AppTabs({ serverCount = 0 }: { serverCount?: number }) {
  const pathname = usePathname() ?? '/'
  /**
   * The shop and a bread's page have a live basket in context. Everywhere else
   * the badge comes from the cart the server read for the layout, which is
   * right until the customer changes it — and they cannot change it from a page
   * that has no catalogue on it.
   */
  const storefront = useStorefrontOptional()
  const count = storefront?.count ?? serverCount

  if (HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null

  return (
    <nav className="app-tabs" aria-label="پیمایش اصلی">
      {TABS.map(({ id, href, labelFa, Icon }) => {
        // Exact for the shop, prefix for the rest: `/` is a prefix of every
        // path, and `/orders/x` is still the orders tab.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
        return (
          <Link
            key={id}
            href={href}
            className={`app-tabs__tab${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon duotone={active} width={22} height={22} />
            <span>{labelFa}</span>
          </Link>
        )
      })}

      {/*
        A button where the drawer exists, a link home where it does not. Opening
        a basket over the shop keeps a customer's place in a list of bread;
        sending somebody from their order history to a page that shows a basket
        and then back does not.
      */}
      <TabShell onOpen={storefront?.openDrawer}>
        <span className="app-tabs__glyph">
          <CartIcon duotone={count > 0} width={22} height={22} />
          {count > 0 && (
            <span className="app-tabs__count" aria-hidden="true">
              {toPersianDigits(String(count))}
            </span>
          )}
        </span>
        <span>سبد خرید</span>
        <span className="visually-hidden">
          {count > 0 ? `${toPersianDigits(String(count))} کالا در سبد` : 'سبد خالی است'}
        </span>
      </TabShell>
    </nav>
  )
}

function TabShell({ onOpen, children }: { onOpen: (() => void) | undefined; children: ReactNode }) {
  if (onOpen) {
    return (
      <button type="button" className="app-tabs__tab" onClick={onOpen}>
        {children}
      </button>
    )
  }
  return (
    <Link href="/" className="app-tabs__tab">
      {children}
    </Link>
  )
}
