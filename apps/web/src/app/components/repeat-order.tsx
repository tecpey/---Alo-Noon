'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { ChevronIcon, ReceiptIcon } from './icons'
import { reorderAction } from '../../lib/engagement-actions'
import { formatToman, toPersianDigits } from '../../lib/persian'

/**
 * Yesterday's order, at the top of the shop, for the customer who has one.
 *
 * This is the shortest path in the product and it was buried. `/orders` has
 * carried a working «سفارش دوباره» for a while, behind a sign-in wall and a tab
 * — so the customer who benefits from it most has to remember it exists and
 * take four taps to reach it. Here it is two: this button, then pay.
 *
 * Bread is the case where that matters more than usual. Repeat purchase is the
 * dominant behaviour of the business — the bread is the same bread as last week
 * — and the accessibility audit named this the single highest-value change
 * available for older customers. Kivetz, Urminsky and Zheng's goal-gradient
 * work says the same thing from the other side: effort near the end of a task
 * is what people actually spend, and a basket that arrives pre-filled moves the
 * customer most of the way to the end before they have spent any.
 *
 * It sits above the hero rather than below it, which is deliberate. The hero
 * argues that this shop is worth trying; somebody with an order history has
 * already accepted that argument, and a returning customer measured 817px of an
 * 844px screen of pitch before the first loaf.
 */
export function RepeatOrder({
  orderId,
  items,
  total,
  placedAt,
}: {
  orderId: string
  items: readonly { readonly nameFa: string; readonly quantity: number }[]
  total: string
  placedAt: string
}) {
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function again() {
    setNotice(null)
    setError(null)
    startTransition(async () => {
      const result = await reorderAction(orderId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      if (result.adjustments.length === 0) {
        router.push('/checkout')
        return
      }
      // Something sold out or ran short since last time. Said here, before
      // checkout, because the alternative is a bag that arrives light and a
      // customer who finds out from the courier.
      setNotice(
        result.adjustments
          .map((adjustment) =>
            adjustment.reason === 'REORDER_QUANTITY_REDUCED'
              ? `${adjustment.nameFa} فقط ${toPersianDigits(String(adjustment.quantity))} عدد موجود بود`
              : `${adjustment.nameFa} الان موجود نیست`,
          )
          .join(' · '),
      )
    })
  }

  return (
    <section className="again" aria-labelledby="again-title">
      <div className="again__head">
        <span className="again__glyph">
          <ReceiptIcon duotone width={22} height={22} />
        </span>
        <div>
          <h2 id="again-title">همان سفارش قبلی</h2>
          <p className="again__when">{formatDate(placedAt)}</p>
        </div>
      </div>

      <p className="again__items">
        {items
          .map((item) => `${item.nameFa} × ${toPersianDigits(String(item.quantity))}`)
          .join('، ')}
      </p>
      <p className="again__total">{formatToman(total)}</p>

      <button type="button" className="an-button again__button" disabled={pending} onClick={again}>
        {pending ? 'در حال آماده‌سازی…' : 'همین را دوباره بفرست'}
        <ChevronIcon width={18} height={18} />
      </button>

      {/*
        `alert` on both. A notice here is never ambient — it is the reason the
        button did not do what the customer expected it to do.
      */}
      {notice && (
        <p className="again__notice" role="alert">
          {notice} — بقیه در سبد است.
        </p>
      )}
      {error && (
        <p className="again__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** Tehran time, in Persian digits, because that is the clock the customer is on. */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'medium',
    timeZone: 'Asia/Tehran',
  }).format(new Date(iso))
}
