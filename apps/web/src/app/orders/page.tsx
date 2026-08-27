import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../storefront.css'
import '../account/account.css'
import './orders.css'

import { BrandMark } from '../components/brand-mark'
import { CheckIcon, ChevronIcon, ReceiptIcon } from '../components/icons'
import { EmptyBasketArt } from '../components/brand-art'
import { formatToman, toPersianDigits } from '../../lib/persian'
import { orderProgress, type OrderStates } from '../../lib/order-display'
import { currentSession, listOrders } from '../../lib/shop-api'

export const metadata: Metadata = {
  title: 'سفارش‌های من | الو نون',
  robots: { index: false, follow: false },
}

/**
 * The customer's own orders.
 *
 * Newest first, and every one of them reduced to a single sentence about where
 * the bread is. The four separate states the system tracks are correct and are
 * not what somebody waiting for lunch wants to read.
 */
export default async function OrdersPage() {
  const session = await currentSession()
  if (!session) redirect('/account')

  const result = await listOrders()

  return (
    <div className="app-frame account">
      <header className="account__head orders__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
        <Link className="an-button an-button--quiet" href="/account">
          حساب کاربری
        </Link>
      </header>

      <main className="account__body">
        <h1>سفارش‌های من</h1>

        {!result.ok ? (
          <p className="orders__failure">{result.error.message}</p>
        ) : result.data.length === 0 ? (
          <div className="orders__empty">
            <EmptyBasketArt className="shelf__empty-art" />
            <p>هنوز سفارشی ثبت نکرده‌اید.</p>
            <Link className="an-button" href="/">
              دیدن نان‌ها
              <ChevronIcon width={18} height={18} />
            </Link>
          </div>
        ) : (
          <ol className="orders">
            {result.data.map((order) => (
              <li key={order.id}>
                <OrderCard order={order} />
              </li>
            ))}
          </ol>
        )}
      </main>
    </div>
  )
}

interface OrderRow extends OrderStates {
  id: string
  publicId: string
  total: { amount: string }
  items: Array<{ id: string; nameFaSnapshot: string; quantity: number }>
  createdAt: string
}

function OrderCard({ order }: { order: OrderRow }) {
  const progress = orderProgress(order)

  return (
    <article className={`order order--${progress.tone}`}>
      <header className="order__head">
        <span className="order__glyph">
          <ReceiptIcon duotone width={20} height={20} />
        </span>
        <div className="order__title">
          <p className="order__headline">{progress.headline}</p>
          <p className="order__meta">
            کد {toPersianDigits(order.publicId)} · {formatDate(order.createdAt)}
          </p>
        </div>
        <span className="order__total">{formatToman(order.total.amount)}</span>
      </header>

      {/*
        A rail rather than a percentage. "۶۰٪" tells a customer nothing about
        whether their bread is baked; four named stops tell them exactly.
      */}
      <ol className="order__rail" aria-label="مراحل سفارش">
        {progress.steps.map((label, index) => {
          const reached = index < progress.step
          return (
            <li key={label} className={reached ? 'is-done' : ''}>
              <span className="order__dot" aria-hidden="true">
                {reached && <CheckIcon width={12} height={12} />}
              </span>
              <span>{label}</span>
            </li>
          )
        })}
      </ol>

      <p className="order__items">
        {order.items
          .map((item) => `${item.nameFaSnapshot} × ${toPersianDigits(String(item.quantity))}`)
          .join('، ')}
      </p>
    </article>
  )
}

/** Tehran time, in Persian digits, because that is the clock the customer is on. */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tehran',
  }).format(new Date(iso))
}
