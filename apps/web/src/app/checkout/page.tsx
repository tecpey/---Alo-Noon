import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../storefront.css'
import './checkout.css'

import { BasketMerge } from '../components/basket-merge'
import { BrandMark } from '../components/brand-mark'
import { CheckoutFlow } from './checkout-flow'
import { EmptyBasketArt } from '../components/brand-art'
import { listAddresses, readCart } from '../../lib/shop-api'
import { isUnauthenticated } from '../../lib/api-core'

export const metadata: Metadata = {
  title: 'تکمیل سفارش | الو نون',
  description: 'انتخاب نشانی، محاسبهٔ کرایه و پرداخت',
}

export const dynamic = 'force-dynamic'

/**
 * Checkout.
 *
 * The page's own job is only to decide whether checkout is possible at all —
 * is there a customer, is there a basket — and to hand the rest to a client
 * component, because choosing an address and reading a browser's location are
 * things that happen in a browser.
 *
 * Everything that touches money stays on the server. The quote, the order and
 * the payment are Server Actions; this page never sees a gateway credential and
 * never decides a price.
 */
export default async function CheckoutPage() {
  const cart = await readCart()

  // Signing in is a step in checkout, not an error in it. The basket survives:
  // it is on the server for a customer and in the browser for a visitor, and
  // this is the one route that genuinely cannot proceed without a session.
  if (!cart.ok && isUnauthenticated(cart.error)) redirect('/account?next=/checkout')

  if (!cart.ok) {
    return (
      <Shell>
        <section className="catalog-state catalog-state--fault" aria-labelledby="checkout-title">
          <h1 id="checkout-title">سبد خرید در دسترس نیست</h1>
          <p>{cart.error.message}</p>
          <Link className="an-button an-button--quiet" href="/">
            بازگشت به فروشگاه
          </Link>
        </section>
      </Shell>
    )
  }

  if (!cart.data || cart.data.items.length === 0) {
    return (
      <Shell>
        <section className="catalog-state" aria-labelledby="checkout-title">
          <EmptyBasketArt className="shelf__empty-art" />
          <h1 id="checkout-title">سبد خرید خالی است</h1>
          <p>اول چند نان انتخاب کنید، بعد این صفحه هزینه و زمان تحویل را حساب می‌کند.</p>
          <Link className="an-button" href="/">
            دیدن نان‌ها
          </Link>
        </section>
      </Shell>
    )
  }

  // A failed address read is not a reason to block checkout: the customer can
  // still add one, which is the same thing they would do with an empty list.
  const addresses = await listAddresses()

  return (
    <Shell>
      <CheckoutFlow cart={cart.data} addresses={addresses.ok ? addresses.data : []} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-frame checkout">
      <header className="checkout__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
      </header>
      {/*
        Mounted here rather than beside the flow so the empty-basket branch
        merges too: that is precisely the state a customer arrives in one
        moment after signing in, with their basket still in the browser.
      */}
      <BasketMerge signedIn />
      <main>{children}</main>
    </div>
  )
}
