'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useRef } from 'react'

import { BreadPlaceholderArt, EmptyBasketArt } from './brand-art'
import { CheckIcon, ChevronIcon, PlusIcon } from './icons'
import { fareLine } from '../../lib/fare-line'
import { useStorefront } from './storefront-state'
import { isRemoteImage } from '../../lib/catalog-view'
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
  const {
    lines,
    catalog,
    add,
    remove,
    saving,
    error,
    drawerOpen,
    closeDrawer,
    fare: estimate,
  } = useStorefront()
  const fare = fareLine(estimate)
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
    /*
      `inert` rather than `aria-hidden`, and the difference is not academic.

      `aria-hidden` takes the closed sheet out of the accessibility tree and
      leaves every button inside it in the tab order. Measured on the running
      page: tabbing the home page landed on «بستن», «بابل» and «دیدن نان‌ها»
      inside a sheet sitting entirely off the right edge — focus vanishing to
      somewhere the customer cannot see, while the screen reader had been told
      that region does not exist. ARIA forbids exactly this pairing: content
      that is focusable must not be `aria-hidden`.

      `inert` removes the subtree from the tab order *and* from the
      accessibility tree, which is the whole intent in one attribute — so the
      scrim's own `tabIndex` dance is no longer needed either.
    */
    <div className={`drawer${drawerOpen ? ' drawer--open' : ''}`} inert={!drawerOpen}>
      <button
        type="button"
        className="drawer__scrim"
        onClick={closeDrawer}
        aria-label="بستن سبد خرید"
      />

      <div
        className={`drawer__panel${saving ? ' is-saving' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="سبد خرید"
        aria-busy={saving}
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
                        unoptimized={isRemoteImage(product.imageUrl)}
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
              {/*
                A refused write is said out loud. The quantity on screen has
                already been replaced by whatever the server actually stored, so
                without this the number would simply spring back with no
                explanation — the single most alarming thing a basket can do.
              */}
              {error && (
                <p className="drawer__error" role="status">
                  {error}
                </p>
              )}
              <div className="drawer__total">
                <span>جمع نان‌ها</span>
                <strong>{formatToman(subtotal)}</strong>
              </div>
              {/*
                The fare, at the moment somebody decides whether to continue.

                This line used to read «کرایه در مرحلهٔ بعد ... محاسبه می‌شود» —
                a promise that a cost exists, with no number, on the last screen
                before the customer commits. Baymard's recommendation is
                specifically the cart rather than the final click, and the shop
                has known its own tariff since the first screen.

                The wording is shared with the shelf so the two cannot make
                different promises about one number. The old sentence survives
                as the fallback, which is the honest thing to say when no tariff
                is published for this scope.
              */}
              <p className="drawer__note">
                <CheckIcon width={16} height={16} />
                {fare ? (
                  <span>
                    {fare.text}
                    {fare.note ? ` — ${fare.note}` : ''}
                  </span>
                ) : (
                  <span>کرایه در مرحلهٔ بعد و بر اساس مسیر واقعی محاسبه می‌شود.</span>
                )}
              </p>
              {fare?.freeOver && <p className="drawer__free">{fare.freeOver}</p>}
              <Link className="an-button drawer__cta" href="/checkout">
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
