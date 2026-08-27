'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useRef } from 'react'

import { BreadPlaceholderArt, EmptyBasketArt } from './brand-art'
import { CheckIcon, ChevronIcon, PlusIcon } from './icons'
import { useStorefront } from './storefront-state'
import { formatToman, sumRial, toPersianDigits } from '../../lib/persian'

/**
 * The basket, as a sheet that rises over the shop rather than a page you leave.
 *
 * A basket on its own route means every glance at what you have chosen costs a
 * navigation and a scroll back to where you were. On a page whose whole job is
 * adding one more loaf, that is the wrong trade.
 *
 * This is the one place the heaviest glass is used, and it is the honest use of
 * it: the shop is still there behind the sheet, dimmed and blurred, which is
 * exactly what a customer needs to feel while deciding whether to add one more
 * thing or check out.
 *
 * Three things a drawer has to get right, all of them here: it closes on
 * Escape, it does not let the page behind it scroll, and it returns focus to
 * the control that opened it.
 */
export function BasketDrawer() {
  const { lines, catalog, add, remove, drawerOpen, closeDrawer } = useStorefront()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!drawerOpen) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer()
    }
    document.addEventListener('keydown', onKey)
    // Without this the shop scrolls under the sheet, which on a phone reads as
    // the sheet having failed to open.
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [drawerOpen, closeDrawer])

  const entries = [...lines.entries()].flatMap(([offeringId, quantity]) => {
    const product = catalog.get(offeringId)
    return product ? [{ product, quantity }] : []
  })
  const subtotal = sumRial(
    entries.map((entry) => ({ priceRial: entry.product.priceRial, quantity: entry.quantity })),
  )

  return (
    <div className={`drawer${drawerOpen ? ' drawer--open' : ''}`} aria-hidden={!drawerOpen}>
      <button
        type="button"
        className="drawer__scrim"
        onClick={closeDrawer}
        tabIndex={drawerOpen ? 0 : -1}
        aria-label="بستن سبد خرید"
      />

      <div
        className="drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="سبد خرید"
        tabIndex={-1}
        ref={panel}
      >
        <header className="drawer__head">
          <h2>سبد خرید</h2>
          <button type="button" className="drawer__close" onClick={closeDrawer}>
            <ChevronIcon />
            <span>بستن</span>
          </button>
        </header>

        {entries.length === 0 ? (
          <div className="drawer__empty">
            <EmptyBasketArt className="drawer__empty-art" />
            <p>هنوز نانی انتخاب نکرده‌اید.</p>
            <button type="button" className="an-button" onClick={closeDrawer}>
              دیدن نان‌ها
            </button>
          </div>
        ) : (
          <>
            <ul className="drawer__lines">
              {entries.map(({ product, quantity }) => (
                <li key={product.offeringId} className="drawer-line">
                  <span className="drawer-line__thumb">
                    {product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt=""
                        width={160}
                        height={120}
                        aria-hidden="true"
                      />
                    ) : (
                      <BreadPlaceholderArt />
                    )}
                  </span>
                  <div className="drawer-line__body">
                    <p className="drawer-line__name">{product.nameFa}</p>
                    <p className="drawer-line__price">{formatToman(product.priceRial)}</p>
                  </div>
                  <div className="stepper">
                    <button
                      type="button"
                      onClick={() => add(product.offeringId)}
                      aria-label={`یکی بیشتر از ${product.nameFa}`}
                    >
                      <PlusIcon width={16} height={16} />
                    </button>
                    <span aria-live="polite">{toPersianDigits(String(quantity))}</span>
                    <button
                      type="button"
                      onClick={() => remove(product.offeringId)}
                      aria-label={`یکی کمتر از ${product.nameFa}`}
                    >
                      <span aria-hidden="true">−</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <footer className="drawer__foot">
              <div className="drawer__total">
                <span>جمع نان‌ها</span>
                <strong>{formatToman(subtotal)}</strong>
              </div>
              {/*
                Deliberately not a checkout button. Checkout needs a signed-in
                customer and the server-side cart, and this basket is browser
                state — a button that said "پرداخت" would be promising a
                transaction nothing behind it can complete.
              */}
              <p className="drawer__note">
                <CheckIcon width={16} height={16} />
                کرایه در مرحلهٔ بعد و بر اساس مسیر واقعی محاسبه می‌شود.
              </p>
              <Link className="an-button drawer__cta" href="/account">
                ادامهٔ سفارش
                <ChevronIcon width={18} height={18} />
              </Link>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
