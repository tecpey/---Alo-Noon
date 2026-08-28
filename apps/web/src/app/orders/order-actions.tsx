'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { CheckIcon, ChevronIcon } from '../components/icons'
import { rateOrderAction, reorderAction } from '../../lib/engagement-actions'
import { toPersianDigits } from '../../lib/persian'

/**
 * The two things a customer does with an order that has already arrived.
 *
 * Order it again, and say how it was. For a daily staple the first of those is
 * most of the business: one tap between somebody and yesterday's basket is one
 * order, and three taps is none.
 */
export function OrderActions({
  orderId,
  completed,
  alreadyRated,
}: {
  orderId: string
  completed: boolean
  /** From the server, so a reload does not offer a form that will be refused. */
  alreadyRated: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rated, setRated] = useState(alreadyRated)
  const [ratingOpen, setRatingOpen] = useState(false)
  const router = useRouter()

  function again() {
    setNotice(null)
    setError(null)
    startTransition(async () => {
      const result = await reorderAction(orderId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      // Straight to checkout. The basket is already exactly what they wanted;
      // sending them back to the shop to find it again is the tap that loses
      // the order.
      if (result.adjustments.length === 0) {
        router.push('/checkout')
        return
      }
      // Something changed since last time, so they see it before they pay
      // rather than after the bag arrives light.
      setNotice(
        result.adjustments
          .map((adjustment) =>
            adjustment.reason === 'REORDER_QUANTITY_REDUCED'
              ? `${adjustment.nameFa} فقط ${toPersianDigits(String(adjustment.quantity))} عدد موجود بود`
              : `${adjustment.nameFa} الان موجود نیست`,
          )
          .join(' · '),
      )
    })
  }

  return (
    <div className="order__actions">
      <div className="order__buttons">
        <button type="button" className="an-button" disabled={pending} onClick={again}>
          {pending ? 'در حال آماده‌سازی…' : 'سفارش دوباره'}
          <ChevronIcon width={16} height={16} />
        </button>
        {completed && !rated && (
          <button
            type="button"
            className="an-button an-button--quiet"
            onClick={() => setRatingOpen((open) => !open)}
          >
            امتیاز به این سفارش
          </button>
        )}
      </div>

      {notice && (
        <p className="order__notice" role="status">
          {notice}{' '}
          <button type="button" className="order__link" onClick={() => router.push('/checkout')}>
            ادامه به پرداخت
          </button>
        </p>
      )}
      {error && (
        <p className="order__error" role="alert">
          {error}
        </p>
      )}
      {rated && (
        <p className="order__notice" role="status">
          <CheckIcon width={16} height={16} /> ممنون از نظرتان.
        </p>
      )}

      {ratingOpen && !rated && (
        <RatingForm
          orderId={orderId}
          onDone={() => {
            setRated(true)
            setRatingOpen(false)
          }}
        />
      )}
    </div>
  )
}

/**
 * Two scores, because two different things can go wrong.
 *
 * The bread is the bakery's and the delivery is the courier's, and one star
 * that blames both teaches nobody anything. Only the bread is required — plenty
 * of people only care about one of them, and demanding both is how a rating
 * form gets abandoned.
 */
function RatingForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [bread, setBread] = useState<number | null>(null)
  const [delivery, setDelivery] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    if (bread === null) return
    setError(null)
    startTransition(async () => {
      const result = await rateOrderAction(
        orderId,
        bread,
        delivery ?? undefined,
        comment.trim() || undefined,
      )
      if (result.ok) onDone()
      else setError(result.message)
    })
  }

  return (
    <div className="rating">
      <Scores label="نان چطور بود؟" value={bread} onChange={setBread} />
      <Scores label="تحویل چطور بود؟" value={delivery} onChange={setDelivery} />
      <label className="rating__comment">
        <span>یادداشت (اختیاری)</span>
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={500}
          rows={2}
        />
      </label>
      {error && (
        <p className="order__error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="an-button"
        disabled={bread === null || pending}
        onClick={submit}
      >
        {pending ? 'در حال ثبت…' : 'ثبت امتیاز'}
      </button>
    </div>
  )
}

const SCORES = [1, 2, 3, 4, 5] as const

function Scores({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange: (score: number) => void
}) {
  return (
    <fieldset className="rating__row">
      <legend>{label}</legend>
      <div className="rating__scores">
        {SCORES.map((score) => (
          <button
            key={score}
            type="button"
            className={`rating__score${value !== null && score <= value ? ' rating__score--on' : ''}`}
            aria-pressed={value === score}
            aria-label={`${toPersianDigits(String(score))} از ۵`}
            onClick={() => onChange(score)}
          >
            {toPersianDigits(String(score))}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
