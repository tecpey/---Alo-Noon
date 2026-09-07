import type { Metadata } from 'next'

import '../storefront.css'

import { EmptyBasketArt } from '../components/brand-art'
import { BrandMark } from '../components/brand-mark'

export const metadata: Metadata = {
  title: 'آفلاین | الو نون',
  // A page that only exists to be shown when the network is gone has nothing to
  // say to a search engine, and would be a strange thing to find in a result.
  robots: { index: false, follow: false },
}

/**
 * Static on purpose, and it has to be.
 *
 * The service worker fetches this page at install time and keeps it. A page
 * that needed the server to render could not be kept, which would leave the one
 * page whose entire job is working without a server as the one page that
 * doesn't.
 */
export const dynamic = 'force-static'

/**
 * What a customer sees with no connection.
 *
 * Without it they get the browser's own offline page: a dinosaur, in English,
 * left to right, with the shop's name nowhere on it. Somebody who installed
 * الو نون to their home screen and tapped it in a lift deserves to be told, by
 * الو نون, that this is the network and not the shop.
 *
 * It deliberately promises nothing about their orders. This page is served from
 * a phone's own storage and has not spoken to the server, so it cannot know
 * whether an order went through — and a reassuring sentence it cannot back up
 * is worse than no sentence.
 *
 * No retry button. A button that cannot know whether it will work is a button
 * that lies twice; the browser's own reload is right there and is honest about
 * what it does.
 */
export default function Offline() {
  return (
    <div className="app-frame">
      <main className="catalog-state" aria-labelledby="offline-title">
        <BrandMark />
        <EmptyBasketArt className="shelf__empty-art" />
        <h1 id="offline-title">اینترنت در دسترس نیست</h1>
        <p>
          الو نون باز شد، ولی به شبکه وصل نشد. وقتی اتصال برگشت، همین صفحه را دوباره باز کنید تا
          نان‌های امروز بیاید.
        </p>
        <p className="catalog-state__note">
          اگر سفارشی ثبت کرده‌اید، وضعیتش را همین‌جا در «سفارش‌ها» می‌بینید — به‌محض وصل شدن.
        </p>
      </main>
    </div>
  )
}
