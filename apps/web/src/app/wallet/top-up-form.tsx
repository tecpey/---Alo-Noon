'use client'

import { useState, useTransition } from 'react'

import { toPersianDigits } from '../../lib/persian'
import { topUpAction } from '../../lib/wallet-actions'
import { TOP_UP_PRESETS_TOMAN } from '../../lib/wallet-view'

/**
 * Charging the balance.
 *
 * Four amounts as one tap, and a field for anything else. The presets are not
 * decoration: a numeric keypad on a phone is exactly where somebody meant to
 * add fifty thousand and added five hundred thousand, and a tap cannot make
 * that mistake.
 *
 * The redirect happens here rather than inside the Server Action because an
 * action that redirects cannot also report that the gateway refused — and a
 * gateway refusing is the case a customer most needs a sentence about.
 */
export function TopUpForm({ suggestedToman }: { suggestedToman?: number }) {
  const [amount, setAmount] = useState(() =>
    suggestedToman ? String(suggestedToman) : String(TOP_UP_PRESETS_TOMAN[1]),
  )
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  const submit = () => {
    setError('')
    start(async () => {
      const result = await topUpAction(amount)
      if (!result.ok) {
        setError(result.message)
        return
      }
      // The gateway is an outside origin, so this is a full navigation rather
      // than a client-side route change.
      window.location.assign(result.url)
    })
  }

  return (
    <section className="wallet__section wallet__topup" aria-labelledby="topup-title">
      <h2 id="topup-title">شارژ کیف پول</h2>
      <p className="wallet__hint">
        مبلغ را انتخاب کنید یا خودتان بنویسید. پرداخت از درگاه بانکی انجام می‌شود.
      </p>

      <div className="wallet__presets" role="group" aria-label="مبلغ‌های پیشنهادی">
        {TOP_UP_PRESETS_TOMAN.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`wallet__preset${String(preset) === amount ? ' is-chosen' : ''}`}
            aria-pressed={String(preset) === amount}
            onClick={() => setAmount(String(preset))}
            disabled={pending}
          >
            {toPersianDigits(preset.toLocaleString('en-US').replace(/,/g, '٬'))} تومان
          </button>
        ))}
      </div>

      <form
        className="wallet__amount-row"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="visually-hidden" htmlFor="topup-amount">
          مبلغ شارژ به تومان
        </label>
        <input
          id="topup-amount"
          className="wallet__amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="مبلغ به تومان"
          disabled={pending}
          required
        />
        <button type="submit" className="an-button" disabled={pending}>
          {pending ? 'در حال اتصال…' : 'پرداخت و شارژ'}
        </button>
      </form>

      {error && (
        <p className="wallet__note wallet__note--error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
