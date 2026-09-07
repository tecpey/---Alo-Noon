'use client'

import { useState, useTransition } from 'react'

import { formatTomanExact } from '../../lib/persian'
import { requestWithdrawalAction } from '../../lib/wallet-actions'

/**
 * Asking for the balance back, in money.
 *
 * Folded away behind a link rather than shown open. Almost nobody wants this on
 * almost every visit — the balance is there to be spent — and a card-number
 * field sitting open on a page somebody opened to check a number is a field
 * that gets filled in by mistake.
 *
 * The form says out loud that it is not instant. A customer who expects money
 * in ten seconds and gets it in two days has been misled by the interface even
 * if nobody wrote a false sentence.
 */
export function WithdrawalForm({ balanceRial }: { balanceRial: string }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [cardNumber, setCardNumber] = useState('')
  const [holder, setHolder] = useState('')
  const [iban, setIban] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [pending, start] = useTransition()

  const submit = () => {
    setError('')
    setDone('')
    start(async () => {
      const result = await requestWithdrawalAction({
        amountToman: amount,
        cardNumber,
        cardHolderName: holder,
        ...(iban.trim() && { iban: iban.trim() }),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      // Cleared on success, and the card most of all: it has done its one job
      // and there is no reason for it to sit in a form field afterwards.
      setCardNumber('')
      setIban('')
      setAmount('')
      setDone(
        `درخواست ثبت شد. مبلغ ${formatTomanExact(result.withdrawal.amount.amount)} از موجودی کم شد و پس از بررسی به کارت شما واریز می‌شود.`,
      )
      setOpen(false)
    })
  }

  return (
    <section className="wallet__section wallet__withdraw" aria-labelledby="withdraw-title">
      <h2 id="withdraw-title">برداشت به کارت بانکی</h2>
      <p className="wallet__hint">
        موجودی کیف پول پول خودتان است و می‌توانید آن را پس بگیرید. واریز دستی و در روزهای کاری انجام
        می‌شود؛ معمولاً یک تا سه روز کاری طول می‌کشد.
      </p>

      {done && (
        <p className="wallet__done" role="status">
          {done}
        </p>
      )}

      {!open ? (
        <button
          type="button"
          className="an-button an-button--quiet"
          onClick={() => setOpen(true)}
          disabled={balanceRial === '0'}
        >
          {balanceRial === '0' ? 'موجودی برای برداشت ندارید' : 'درخواست برداشت'}
        </button>
      ) : (
        <form
          className="wallet__withdraw-form"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <label htmlFor="withdraw-amount">مبلغ به تومان</label>
          <input
            id="withdraw-amount"
            className="wallet__amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            required
            disabled={pending}
          />

          <label htmlFor="withdraw-card">شمارهٔ کارت ۱۶ رقمی</label>
          <input
            id="withdraw-card"
            className="wallet__amount"
            value={cardNumber}
            onChange={(event) => setCardNumber(event.target.value)}
            inputMode="numeric"
            dir="ltr"
            // Never remembered by the browser and never sent anywhere but this
            // one request: only the last four digits are kept, and the rest
            // should not outlive the form either.
            autoComplete="off"
            required
            disabled={pending}
          />

          <label htmlFor="withdraw-holder">نام صاحب کارت</label>
          <input
            id="withdraw-holder"
            className="wallet__amount"
            value={holder}
            onChange={(event) => setHolder(event.target.value)}
            autoComplete="off"
            required
            disabled={pending}
          />

          <label htmlFor="withdraw-iban">شبا (اختیاری)</label>
          <input
            id="withdraw-iban"
            className="wallet__amount"
            value={iban}
            onChange={(event) => setIban(event.target.value)}
            dir="ltr"
            placeholder="IR..."
            autoComplete="off"
            disabled={pending}
          />
          <p className="wallet__hint">
            کارت باید به نام خودتان باشد. واریز به کارت شخص دیگر انجام نمی‌شود.
          </p>

          <div className="wallet__withdraw-actions">
            <button type="submit" className="an-button" disabled={pending}>
              {pending ? 'در حال ثبت…' : 'ثبت درخواست'}
            </button>
            <button
              type="button"
              className="an-button an-button--quiet"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              انصراف
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="wallet__failure" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
