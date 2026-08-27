import type { Metadata } from 'next'

import type { OrderSummary } from '@alo-noon/contracts'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../../storefront.css'
import '../../checkout/checkout.css'

import { BrandMark } from '../../components/brand-mark'
import { CheckIcon, ClockIcon, ShieldIcon } from '../../components/icons'
import { EmptyBasketArt } from '../../components/brand-art'
import { RetryButton } from '../../components/retry-button'
import { isUnauthenticated } from '../../../lib/api-core'
import { formatToman, toPersianDigits } from '../../../lib/persian'
import { listOrders } from '../../../lib/shop-api'
import { orderProgress } from '../../../lib/order-display'

export const metadata: Metadata = {
  title: 'نتیجهٔ پرداخت | الو نون',
}

export const dynamic = 'force-dynamic'

/**
 * Where the gateway sends the customer back to.
 *
 * The bank returns a browser, not a verdict. The real answer arrives on the
 * API's own callback, which records a receipt and settles the payment before
 * this redirect is issued — so by the time anyone reads this page the order
 * usually already knows. What this page must never do is decide the outcome
 * from the query string it was handed: a customer who edits `reference` in the
 * address bar must not be able to talk this page into saying "paid".
 *
 * So it reads the order back from the API and reports whatever the order says.
 * If settlement is still in flight the honest answer is "we are confirming",
 * with a way to look again — not a guess in either direction.
 */
export default async function PaymentResultPage() {
  const orders = await listOrders()

  if (!orders.ok && isUnauthenticated(orders.error)) redirect('/account?next=/orders')

  const latest = orders.ok ? orders.data[0] : undefined

  return (
    <div className="app-frame checkout">
      <header className="checkout__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
      </header>

      <main className="result">
        {!orders.ok ? (
          <section className="catalog-state catalog-state--fault">
            <h1>وضعیت پرداخت خوانده نشد</h1>
            <p>{orders.error.message}</p>
            <RetryButton>تلاش دوباره</RetryButton>
          </section>
        ) : !latest ? (
          <section className="catalog-state">
            <EmptyBasketArt className="shelf__empty-art" />
            <h1>سفارشی پیدا نشد</h1>
            <p>اگر همین حالا پرداخت کرده‌اید، چند لحظه بعد از بخش سفارش‌ها بررسی کنید.</p>
            <Link className="an-button" href="/orders">
              سفارش‌های من
            </Link>
          </section>
        ) : (
          <Outcome order={latest} />
        )}
      </main>
    </div>
  )
}

function Outcome({ order }: { order: OrderSummary }) {
  const progress = orderProgress(order)
  // The order's own payment states, not the Payment entity's. An order is PAID
  // only once settlement has actually posted; PENDING is the gap between the
  // customer leaving the gateway and the callback being processed.
  const paid = order.paymentState === 'PAID'
  const settling = order.paymentState === 'PENDING'

  return (
    <section className={`result__card result__card--${paid ? 'good' : settling ? 'wait' : 'bad'}`}>
      <span className="result__glyph" aria-hidden="true">
        {paid ? (
          <CheckIcon width={30} height={30} />
        ) : settling ? (
          <ClockIcon duotone width={30} height={30} />
        ) : (
          <ShieldIcon duotone width={30} height={30} />
        )}
      </span>

      <h1>{paid ? 'پرداخت انجام شد' : settling ? 'در حال تأیید پرداخت' : 'پرداخت تکمیل نشد'}</h1>

      <p className="result__lead">
        {paid
          ? 'سفارش شما ثبت شد و برای نانوایی ارسال شده است.'
          : settling
            ? 'پاسخ درگاه هنوز نهایی نشده است. این صفحه را دوباره باز کنید یا از بخش سفارش‌ها پیگیری کنید.'
            : 'مبلغی از حساب شما کم نشده است. می‌توانید از بخش سفارش‌ها دوباره تلاش کنید.'}
      </p>

      <dl className="result__facts">
        <div>
          <dt>شمارهٔ سفارش</dt>
          <dd>{toPersianDigits(order.publicId)}</dd>
        </div>
        <div>
          <dt>مبلغ</dt>
          <dd>{formatToman(order.total.amount)}</dd>
        </div>
        <div>
          <dt>وضعیت</dt>
          <dd>{progress.headline}</dd>
        </div>
      </dl>

      <div className="result__actions">
        <Link className="an-button" href="/orders">
          پیگیری سفارش
        </Link>
        {settling && <RetryButton>بررسی دوباره</RetryButton>}
        <Link className="an-button an-button--quiet" href="/">
          ادامهٔ خرید
        </Link>
      </div>
    </section>
  )
}
