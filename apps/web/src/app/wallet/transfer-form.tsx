'use client'

import { useState, useTransition } from 'react'

import type { WalletTransferSummary } from '@alo-noon/contracts'

import { ShieldIcon } from '../components/icons'
import { formatToman, toPersianDigits } from '../../lib/persian'
import { confirmTransferAction, openTransferAction } from '../../lib/wallet-actions'

/**
 * Sending part of the balance to somebody else.
 *
 * Two steps, and the middle of them is the point. Between naming a number and
 * moving money, the customer is shown who they are about to pay — masked, but
 * enough to recognise the person they meant — and has to type a code sent to
 * their own handset.
 *
 * That pause exists because a phone number is a silent way to be wrong. One
 * mistyped digit reaches a real stranger's balance and nothing bounces. The
 * masked name and last four digits are the last chance anybody has to notice.
 *
 * A transfer already waiting for its code is resumed rather than restarted: a
 * customer who closed the tab comes back to the code field, not to a form that
 * would charge them a second SMS to reach the same place.
 */
export function TransferForm({ pending }: { pending: WalletTransferSummary | null }) {
  const [open, setOpen] = useState<WalletTransferSummary | null>(pending)
  const [mobile, setMobile] = useState('')
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<WalletTransferSummary | null>(null)
  const [busy, start] = useTransition()

  const beginTransfer = () => {
    setError('')
    start(async () => {
      const result = await openTransferAction({ recipientMobile: mobile, amountToman: amount })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setOpen(result.transfer)
      setCode('')
    })
  }

  const finishTransfer = () => {
    if (!open) return
    setError('')
    start(async () => {
      const result = await confirmTransferAction(open.id, code)
      if (!result.ok) {
        setError(
          result.attemptsLeft === undefined
            ? result.message
            : `${result.message} ${toPersianDigits(String(result.attemptsLeft))} تلاش دیگر باقی است.`,
        )
        // A dead transfer must not keep a code field on screen promising a
        // second chance that does not exist.
        if (!result.retryable) setOpen(null)
        return
      }
      setDone(result.transfer)
      setOpen(null)
      setMobile('')
      setAmount('')
      setCode('')
    })
  }

  if (done) {
    return (
      <section className="wallet__section wallet__transfer" aria-labelledby="transfer-title">
        <h2 id="transfer-title">انتقال به کیف پول دیگر</h2>
        <p className="wallet__note wallet__note--ok" role="status">
          {formatToman(done.amount.amount)} به{' '}
          {done.recipientName ?? toPersianDigits(done.recipientMobileMasked)} منتقل شد.
        </p>
        <button type="button" className="an-button an-button--quiet" onClick={() => setDone(null)}>
          انتقال دیگر
        </button>
      </section>
    )
  }

  return (
    <section className="wallet__section wallet__transfer" aria-labelledby="transfer-title">
      <h2 id="transfer-title">انتقال به کیف پول دیگر</h2>

      {open ? (
        <>
          {/* Who and how much, restated. This is the sentence that catches a
              wrong digit, so it is the largest thing in the step. */}
          <p className="wallet__confirm">
            <strong>{formatToman(open.amount.amount)}</strong> به{' '}
            <strong>{open.recipientName ?? toPersianDigits(open.recipientMobileMasked)}</strong>
          </p>
          <p className="wallet__hint">کد تأیید به شمارهٔ خودتان پیامک شد.</p>

          <form
            className="wallet__amount-row"
            onSubmit={(event) => {
              event.preventDefault()
              finishTransfer()
            }}
          >
            <label className="visually-hidden" htmlFor="transfer-code">
              کد تأیید
            </label>
            <input
              id="transfer-code"
              className="wallet__amount wallet__code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="------"
              disabled={busy}
              required
            />
            <button type="submit" className="an-button" disabled={busy}>
              {busy ? 'در حال بررسی…' : 'تأیید و انتقال'}
            </button>
          </form>

          <button
            type="button"
            className="wallet__link"
            onClick={() => {
              setOpen(null)
              setError('')
            }}
            disabled={busy}
          >
            انصراف
          </button>
        </>
      ) : (
        <form
          className="wallet__transfer-fields"
          onSubmit={(event) => {
            event.preventDefault()
            beginTransfer()
          }}
        >
          <div>
            <label htmlFor="transfer-mobile">شمارهٔ موبایل گیرنده</label>
            <input
              id="transfer-mobile"
              className="wallet__amount"
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="۰۹۱۲۱۲۳۴۵۶۷"
              disabled={busy}
              required
            />
          </div>
          <div>
            <label htmlFor="transfer-amount">مبلغ به تومان</label>
            <input
              id="transfer-amount"
              className="wallet__amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="۵۰٬۰۰۰"
              disabled={busy}
              required
            />
          </div>
          <button type="submit" className="an-button" disabled={busy}>
            {busy ? 'در حال ارسال کد…' : 'ادامه'}
          </button>
        </form>
      )}

      {error && (
        <p className="wallet__note wallet__note--error" role="alert">
          {error}
        </p>
      )}

      <p className="wallet__reassure">
        <ShieldIcon width={16} height={16} />
        گیرنده باید قبلاً در الو نون ثبت‌نام کرده باشد. انتقال بدون کد تأیید انجام نمی‌شود.
      </p>
    </section>
  )
}
