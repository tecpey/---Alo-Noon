'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import type { AddressSummary, CartSummary, QuoteSummary } from '@alo-noon/contracts'

import { AddressForm } from './address-form'
import { CheckIcon, ChevronIcon, CourierIcon, PinIcon, ShieldIcon } from '../components/icons'
import { formatToman, toPersianDigits } from '../../lib/persian'
import { payAction, quoteAction } from '../../lib/checkout-actions'
import { translateProviderError } from '../../lib/admin-format'

/**
 * The three questions checkout asks, in the order they can be answered.
 *
 * Where it goes, what it costs, and paying for it — and the second cannot be
 * answered before the first, because the fare is measured to the address. They
 * are one page rather than three routes: a bread order is small enough that
 * three navigations would be most of the work, and a customer who has to go
 * back to change an address should not lose their place.
 *
 * The total is never computed here. It comes from a quote the API cut, which is
 * priced against a cart version and expires — the number on screen is the
 * number that will be charged, and if this component did the arithmetic itself
 * it would eventually disagree with the ledger.
 */
export function CheckoutFlow({
  cart,
  addresses,
}: {
  cart: CartSummary
  addresses: readonly AddressSummary[]
}) {
  const [saved, setSaved] = useState<readonly AddressSummary[]>(addresses)
  const [selected, setSelected] = useState<string | null>(addresses[0]?.id ?? null)
  const [adding, setAdding] = useState(addresses.length === 0)
  const [quote, setQuote] = useState<QuoteSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function priceIt(addressId: string) {
    setError(null)
    setQuote(null)
    startTransition(async () => {
      const result = await quoteAction(addressId, code.trim() || undefined)
      if (result.ok) setQuote(result.quote)
      else setError(result.message)
    })
  }

  function pay() {
    if (!quote) return
    setError(null)
    startTransition(async () => {
      const result = await payAction(quote.id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      if (result.kind === 'redirect') {
        // A full navigation, not a router push: this address belongs to the
        // gateway, not to this application.
        window.location.href = result.url
        return
      }
      // The order is real and placed; only the gateway declined to open.
      //
      // The customer goes to the result page rather than staying here with a
      // message. Two reasons, and the second is the one that matters: their
      // basket has just been consumed into the order, so this page would say
      // "سبد خرید خالی است" on the next refresh — and a notice held in client
      // state does not survive the re-render that placing the order triggers,
      // which left a customer looking at a checkout page that silently did
      // nothing while their order sat waiting to be paid.
      router.push('/payments/result')
    })
  }

  const chosen = saved.find((address) => address.id === selected) ?? null

  return (
    <div className="checkout__grid">
      <div className="checkout__main">
        <h1>تکمیل سفارش</h1>

        <section className="checkout__step" aria-labelledby="address-step">
          <h2 id="address-step">
            <span className="checkout__num">{toPersianDigits('1')}</span>
            نشانی تحویل
          </h2>

          {saved.length > 0 && (
            <ul className="address-list">
              {saved.map((address) => (
                <li key={address.id}>
                  <label className={`address${address.id === selected ? ' address--on' : ''}`}>
                    <input
                      type="radio"
                      name="address"
                      value={address.id}
                      checked={address.id === selected}
                      onChange={() => {
                        setSelected(address.id)
                        setQuote(null)
                      }}
                    />
                    <span className="address__glyph">
                      <PinIcon duotone width={20} height={20} />
                    </span>
                    <span className="address__body">
                      <span className="address__label">{address.label}</span>
                      <span className="address__line">{address.addressLine}</span>
                      <span className="address__who">
                        {address.recipientName} — {toPersianDigits(address.recipientPhone)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <AddressForm
              onSaved={(address) => {
                setSaved((current) => [address, ...current])
                setSelected(address.id)
                setAdding(false)
                setQuote(null)
              }}
              {...(saved.length > 0 && { onCancel: () => setAdding(false) })}
            />
          ) : (
            <button
              type="button"
              className="an-button an-button--quiet"
              onClick={() => setAdding(true)}
            >
              افزودن نشانی تازه
            </button>
          )}
        </section>

        <section className="checkout__step" aria-labelledby="price-step">
          <h2 id="price-step">
            <span className="checkout__num">{toPersianDigits('2')}</span>
            هزینه و کرایه
          </h2>
          {chosen ? (
            <>
              <p className="checkout__hint">
                کرایه بر اساس مسیر واقعی تا «{chosen.label}» اندازه‌گیری می‌شود.
              </p>

              {/*
                The code goes in beside the price button rather than at the end
                of checkout. A customer holding a code wants to see it work
                before they commit, and one who finds the field after paying
                has a complaint rather than an order.
              */}
              <div className="promo">
                <label className="promo__label" htmlFor="promotionCode">
                  کد تخفیف (اختیاری)
                </label>
                <div className="promo__row">
                  <input
                    id="promotionCode"
                    name="promotionCode"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    maxLength={64}
                    autoComplete="off"
                    placeholder="مثلاً NOON10"
                  />
                </div>
                {quote?.promotionRefusal && (
                  <p className="promo__refused" role="status">
                    {translateProviderError(quote.promotionRefusal, 'این کد اعمال نشد.')}
                  </p>
                )}
                {quote?.promotion && (
                  <p className="promo__applied" role="status">
                    <CheckIcon width={16} height={16} />«{quote.promotion.nameFa}» اعمال شد
                    {quote.promotion.basis === 'DELIVERY_FEE' && ' — کرایه رایگان'}.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="an-button an-button--quiet"
                disabled={pending}
                onClick={() => priceIt(chosen.id)}
              >
                {pending && !quote ? 'در حال محاسبه…' : quote ? 'محاسبهٔ دوباره' : 'محاسبهٔ هزینه'}
              </button>
            </>
          ) : (
            <p className="checkout__hint">اول یک نشانی انتخاب کنید.</p>
          )}
        </section>
      </div>

      <aside className="checkout__summary" aria-label="خلاصهٔ سفارش">
        <h2>خلاصهٔ سفارش</h2>
        <ul className="summary__lines">
          {cart.items.map((item) => (
            <li key={item.id}>
              <span>
                {item.nameFa}
                <span className="summary__times"> × {toPersianDigits(String(item.quantity))}</span>
              </span>
              <strong>{formatToman(item.lineTotal.amount)}</strong>
            </li>
          ))}
        </ul>

        <dl className="summary__totals">
          <div>
            <dt>جمع نان‌ها</dt>
            <dd>{formatToman(quote ? quote.subtotal.amount : cart.subtotal.amount)}</dd>
          </div>
          <div>
            <dt>کرایهٔ پیک</dt>
            <dd>{quote ? formatToman(quote.deliveryFee.amount) : '—'}</dd>
          </div>
          {quote && quote.discount.amount !== '0' && (
            <div>
              <dt>تخفیف</dt>
              <dd>−{formatToman(quote.discount.amount)}</dd>
            </div>
          )}
          <div className="summary__grand">
            <dt>مبلغ قابل پرداخت</dt>
            <dd>{quote ? formatToman(quote.total.amount) : '—'}</dd>
          </div>
        </dl>

        {!quote && (
          <p className="checkout__hint">
            <CourierIcon width={16} height={16} />
            کرایه پس از انتخاب نشانی محاسبه می‌شود.
          </p>
        )}

        {error && (
          <p className="checkout__error" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className="an-button checkout__pay"
          disabled={!quote || pending}
          onClick={pay}
        >
          {pending && quote ? (
            'در حال اتصال به درگاه…'
          ) : (
            <>
              <CheckIcon width={18} height={18} />
              پرداخت
              <ChevronIcon width={18} height={18} />
            </>
          )}
        </button>

        <p className="checkout__trust">
          <ShieldIcon width={16} height={16} />
          پرداخت در درگاه بانکی انجام می‌شود و تأیید نهایی با پاسخ خود درگاه است.
        </p>
      </aside>
    </div>
  )
}
