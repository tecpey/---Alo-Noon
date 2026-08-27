'use client'

import { useState, useTransition } from 'react'

import type { AddressSummary } from '@alo-noon/contracts'

import { PinIcon } from '../components/icons'
import { createAddressAction } from '../../lib/checkout-actions'

interface Fix {
  latitude: number
  longitude: number
  /** Metres of uncertainty the browser reported, when it reported any. */
  accuracy: number | null
}

/**
 * Adding a delivery address.
 *
 * The coordinates are taken from the browser rather than typed, because they
 * are not decoration: the API decides from them whether any bakery can reach
 * this address at all, and the courier's fare is measured along the road to
 * them. A house number a customer mistypes is a wrong label on a saved address;
 * a coordinate they mistype is a courier sent to another town with hot bread.
 *
 * A map picker would be better, and is what this becomes once there is a
 * mapping key to draw tiles with. Until then the honest options are the
 * device's own position or nothing, and asking someone to type a latitude would
 * be nothing dressed up as a choice.
 */
export function AddressForm({
  onSaved,
  onCancel,
}: {
  onSaved: (address: AddressSummary) => void
  onCancel?: () => void
}) {
  const [fix, setFix] = useState<Fix | null>(null)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function locate() {
    setError(null)
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('مرورگر شما موقعیت مکانی را در اختیار نمی‌گذارد.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFix({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        })
        setLocating(false)
      },
      (failure) => {
        setLocating(false)
        // Each of these needs a different thing from the customer, so they are
        // not collapsed into one apology.
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? 'دسترسی به موقعیت مکانی رد شد. برای ثبت نشانی، اجازهٔ دسترسی را بدهید.'
            : failure.code === failure.POSITION_UNAVAILABLE
              ? 'موقعیت مکانی در دسترس نیست. اگر داخل ساختمان هستید، نزدیک پنجره دوباره تلاش کنید.'
              : 'پیدا کردن موقعیت طول کشید. دوباره تلاش کنید.',
        )
      },
      // A cached fix from an hour ago may be a different neighbourhood, so the
      // browser is asked for a recent and precise one.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  function submit(form: FormData) {
    if (!fix) {
      setError('اول موقعیت مکانی را ثبت کنید.')
      return
    }
    setError(null)
    const value = (name: string) => String(form.get(name) ?? '')
    startTransition(async () => {
      const result = await createAddressAction({
        label: value('label'),
        recipientName: value('recipientName'),
        recipientPhone: value('recipientPhone'),
        addressLine: value('addressLine'),
        latitude: fix.latitude,
        longitude: fix.longitude,
        deliveryInstructions: value('deliveryInstructions'),
      })
      if (result.ok) onSaved(result.address)
      else setError(result.message)
    })
  }

  return (
    <form className="address-form" action={submit}>
      <div className="address-form__locate">
        <button type="button" className="an-button an-button--quiet" onClick={locate}>
          <PinIcon width={18} height={18} />
          {locating ? 'در حال یافتن موقعیت…' : fix ? 'ثبت دوبارهٔ موقعیت' : 'ثبت موقعیت من'}
        </button>
        {fix && (
          <p className="address-form__fix" role="status">
            موقعیت ثبت شد
            {fix.accuracy !== null && ` (با دقت حدود ${Math.round(fix.accuracy)} متر)`}.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="addressLine">نشانی کامل</label>
        <textarea
          id="addressLine"
          name="addressLine"
          rows={2}
          required
          minLength={10}
          maxLength={500}
          placeholder="خیابان، کوچه، پلاک و واحد"
        />
      </div>

      <div className="address-form__row">
        <div className="field">
          <label htmlFor="recipientName">نام گیرنده</label>
          <input id="recipientName" name="recipientName" required minLength={2} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="recipientPhone">شمارهٔ گیرنده</label>
          <input
            id="recipientPhone"
            name="recipientPhone"
            inputMode="tel"
            required
            placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          />
        </div>
      </div>

      <div className="address-form__row">
        <div className="field">
          <label htmlFor="label">عنوان</label>
          <input id="label" name="label" maxLength={80} placeholder="خانه" />
        </div>
        <div className="field">
          <label htmlFor="deliveryInstructions">توضیح برای پیک (اختیاری)</label>
          <input id="deliveryInstructions" name="deliveryInstructions" maxLength={500} />
        </div>
      </div>

      {error && (
        <p className="checkout__error" role="alert">
          {error}
        </p>
      )}

      <div className="address-form__actions">
        <button type="submit" className="an-button" disabled={pending || !fix}>
          {pending ? 'در حال ثبت…' : 'ذخیرهٔ نشانی'}
        </button>
        {onCancel && (
          <button type="button" className="an-button an-button--quiet" onClick={onCancel}>
            انصراف
          </button>
        )}
      </div>
    </form>
  )
}
