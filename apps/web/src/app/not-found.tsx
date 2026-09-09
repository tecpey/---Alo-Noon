import type { Metadata } from 'next'
import Link from 'next/link'

import './storefront.css'

import { EmptyBasketArt } from './components/brand-art'
import { BrandMark } from './components/brand-mark'

export const metadata: Metadata = {
  title: 'صفحه پیدا نشد | الو نون',
}

/**
 * Where a wrong address lands.
 *
 * Without this, `notFound()` drops the customer on Next.js's own black-and-white
 * page — a different typeface, a different language, and no way back into the
 * shop. A mistyped or expired product link is an ordinary thing to do, and the
 * only useful response is a door back to the bread.
 */
export default function NotFound() {
  return (
    <div className="app-frame">
      <main className="catalog-state" aria-labelledby="notfound-title">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
        <EmptyBasketArt className="shelf__empty-art" />
        <h1 id="notfound-title">این صفحه پیدا نشد</h1>
        <p>
          شاید نشانی اشتباه تایپ شده باشد، یا این نان دیگر در شهر شما عرضه نمی‌شود. از فهرست نان‌ها
          می‌توانید ادامه دهید.
        </p>
        <Link className="an-button" href="/">
          بازگشت به فروشگاه
        </Link>
      </main>
    </div>
  )
}
