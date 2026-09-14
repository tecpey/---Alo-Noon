'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import type { AddressSummary, PlaceCandidate } from '@alo-noon/contracts'

import { PinIcon } from '../components/icons'
import {
  createAddressAction,
  reverseGeocodeAction,
  searchPlacesAction,
} from '../../lib/checkout-actions'

interface Fix {
  latitude: number
  longitude: number
  /**
   * Metres of uncertainty the browser reported, when it reported any. Null for
   * a position chosen from the search results, which has no such notion — it is
   * exactly where the map provider says that place is.
   */
  accuracy: number | null
  /** What to call the position in the interface, once it has a name. */
  label?: string
}

/**
 * How long to wait after the last keystroke before searching.
 *
 * Every search is a paid call against the bakery's mapping quota, and the
 * endpoint allows thirty a minute. Typing a street name at a normal speed
 * would spend most of that on prefixes nobody wanted the answer to, and then
 * rate-limit the customer out of the search that mattered.
 */
const SEARCH_DEBOUNCE_MS = 450

/**
 * Adding a delivery address.
 *
 * The coordinates are taken from the browser rather than typed, because they
 * are not decoration: the API decides from them whether any bakery can reach
 * this address at all, and the courier's fare is measured along the road to
 * them. A house number a customer mistypes is a wrong label on a saved address;
 * a coordinate they mistype is a courier sent to another town with hot bread.
 *
 * There are now two ways to get one, and the second exists because the first
 * was not always available. `navigator.geolocation` can be refused, and indoors
 * it can simply never resolve — and while it was the only path, either of those
 * meant the customer could not give an address and so could not order at all.
 * Searching by name goes through the tenant's own mapping provider, so it works
 * on a denied permission, a desktop browser and a phone with no signal indoors.
 *
 * Typing a latitude is still not offered, and never will be: it is nothing
 * dressed up as a choice. What is missing is a draggable pin on a map, which
 * needs tiles rather than an API call; the reverse geocode below is the stopgap
 * that at least lets somebody read back where they have been put.
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

  const [term, setTerm] = useState('')
  const [candidates, setCandidates] = useState<PlaceCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searchNote, setSearchNote] = useState<string | null>(null)
  /**
   * Whether this tenant has mapping at all. Starts true so the box is there on
   * first paint, and is turned off for good the first time the server says the
   * capability is absent — an interface that offers a search which can never
   * work is worse than one that never offered it.
   */
  const [searchable, setSearchable] = useState(true)

  /**
   * Which search this is. An earlier request that resolves after a later one
   * would otherwise overwrite the newer results with staler ones — the classic
   * way a search box ends up showing answers to a question the customer has
   * already finished changing.
   */
  const requestSeq = useRef(0)

  useEffect(() => {
    if (!searchable) return
    const trimmed = term.trim()
    if (trimmed.length < 3) {
      setCandidates([])
      setSearchNote(null)
      setSearching(false)
      return
    }
    const seq = ++requestSeq.current
    setSearching(true)
    const timer = setTimeout(() => {
      void searchPlacesAction(trimmed).then((outcome) => {
        if (seq !== requestSeq.current) return
        setSearching(false)
        if (outcome.state === 'unsupported') {
          setSearchable(false)
          setCandidates([])
          return
        }
        if (outcome.state === 'failed') {
          setCandidates([])
          setSearchNote(outcome.message)
          return
        }
        setCandidates(outcome.candidates)
        setSearchNote(
          outcome.candidates.length === 0
            ? 'جایی با این نام پیدا نشد. نام دیگری را امتحان کنید.'
            : null,
        )
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, searchable])

  function choose(candidate: PlaceCandidate) {
    setError(null)
    setFix({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      accuracy: null,
      label: candidate.address ?? candidate.title,
    })
    // The list has done its job. Leaving it open invites a second pick that
    // silently replaces the first, with nothing on screen saying which won.
    setCandidates([])
    setTerm('')
    setSearchNote(null)
  }

  function locate() {
    setError(null)
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('مرورگر شما موقعیت مکانی را در اختیار نمی‌گذارد.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const located: Fix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        }
        setFix(located)
        setLocating(false)
        // Best-effort, and deliberately not awaited: the position is already
        // usable, and naming it is a courtesy that lets the customer notice the
        // phone put them on the next street. A failure changes nothing.
        void reverseGeocodeAction(located.latitude, located.longitude).then((label) => {
          if (!label) return
          setFix((current) =>
            current &&
            current.latitude === located.latitude &&
            current.longitude === located.longitude
              ? { ...current, label }
              : current,
          )
        })
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
      // Names both ways, because whichever one the customer has already tried
      // and failed at is the one this message must not send them back to.
      setError(
        searchable
          ? 'اول محل را از جست‌وجو انتخاب کنید یا موقعیت خود را ثبت کنید.'
          : 'اول موقعیت مکانی را ثبت کنید.',
      )
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
      {/*
        Two ways to the same coordinate, and the order is the point. The search
        is first because it is the one that always works: the position button
        needs a permission the customer may refuse and a fix that may never
        arrive indoors, and until this existed refusing it meant not ordering.
      */}
      {searchable && (
        <div className="address-form__search">
          <label htmlFor="placeSearch">جست‌وجوی نشانی</label>
          <input
            id="placeSearch"
            type="search"
            autoComplete="off"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="نام خیابان، میدان یا یک جای شناخته‌شده"
            aria-describedby="placeSearchHint"
            // The list is a suggestion, not a form control: `aria-expanded`
            // and a listbox role would promise keyboard semantics this does
            // not implement, which is worse for a screen reader than plain
            // buttons under a labelled field.
          />
          <p className="address-form__hint" id="placeSearchHint">
            نزدیک‌ترین جای شناخته‌شده را پیدا کنید، بعد پلاک و واحد را در «نشانی کامل» بنویسید.
          </p>
          {searching && (
            <p className="address-form__hint" role="status">
              در حال جست‌وجو…
            </p>
          )}
          {candidates.length > 0 && (
            <ul className="address-form__results">
              {candidates.map((candidate) => (
                <li key={`${candidate.latitude},${candidate.longitude},${candidate.title}`}>
                  <button type="button" onClick={() => choose(candidate)}>
                    <span className="address-form__result-title">{candidate.title}</span>
                    {candidate.address && (
                      <span className="address-form__result-address">{candidate.address}</span>
                    )}
                    {candidate.distanceMetres !== null && (
                      <span className="address-form__result-distance">
                        {candidate.distanceMetres < 1_000
                          ? `${candidate.distanceMetres} متر`
                          : `${(candidate.distanceMetres / 1_000).toFixed(1)} کیلومتر`}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searchNote && !searching && (
            <p className="address-form__hint" role="status">
              {searchNote}
            </p>
          )}
        </div>
      )}

      <div className="address-form__locate">
        <button type="button" className="an-button an-button--quiet" onClick={locate}>
          <PinIcon width={18} height={18} />
          {locating ? 'در حال یافتن موقعیت…' : fix ? 'ثبت دوبارهٔ موقعیت' : 'ثبت موقعیت من'}
        </button>
        {fix && (
          <p className="address-form__fix" role="status">
            موقعیت ثبت شد
            {fix.accuracy !== null && ` (با دقت حدود ${Math.round(fix.accuracy)} متر)`}.
            {fix.label && <span className="address-form__fix-label">{fix.label}</span>}
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
