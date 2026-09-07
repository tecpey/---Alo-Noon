'use client'

import Link from 'next/link'

import './storefront.css'

import { EmptyBasketArt } from './components/brand-art'
import { BrandMark } from './components/brand-mark'

/**
 * Where a page that threw lands.
 *
 * Without this file, an uncaught error anywhere in the shop renders Next.js's
 * own fallback: black on white, left to right, in English, saying
 * "Application error: a server-side exception has occurred". A Persian customer
 * who has just handed over money and seen that has no way of telling a bug from
 * a theft, and the shop has no way of telling them.
 *
 * The digest stays on the page on purpose. It is the only thing that connects
 * what the customer saw to what the server logged, and a support conversation
 * that starts with "the screen went white" cannot be finished. It is a hash of
 * the error — never its message — so it carries nothing about the customer or
 * the failure to a screen somebody else might be looking over.
 *
 * `reset` re-renders the segment without a full page load, which is the right
 * first move: most of what can throw here is a network call to the API, and
 * most of those work the second time.
 */
export default function ShopError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="app-frame">
      <main className="catalog-state catalog-state--fault" aria-labelledby="error-title">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
        <EmptyBasketArt className="shelf__empty-art" />
        <h1 id="error-title">این صفحه بالا نیامد</h1>
        <p>
          مشکلی از سمت ما پیش آمد و این صفحه ساخته نشد. سفارش‌ها و موجودی کیف پول شما دست‌نخورده
          است. یک‌بار دیگر تلاش کنید؛ اگر باز هم تکرار شد، با پشتیبانی تماس بگیرید.
        </p>
        <div className="catalog-state__actions">
          <button className="an-button" type="button" onClick={reset}>
            تلاش دوباره
          </button>
          <Link className="an-button an-button--quiet" href="/">
            بازگشت به فروشگاه
          </Link>
        </div>
        {error.digest ? (
          <p className="catalog-state__note">
            کد پیگیری این خطا: <code dir="ltr">{error.digest}</code>
          </p>
        ) : null}
      </main>
    </div>
  )
}
