'use client'

import { useActionState } from 'react'

import { ChevronIcon, ShieldIcon } from '../components/icons'
import { idleState } from '../../lib/action-state'
import { requestShopOtpAction, verifyShopOtpAction } from '../../lib/shop-actions'

/**
 * Signing in, in two steps on one screen.
 *
 * Both steps stay visible: a customer who mistyped their number needs to fix it
 * without losing the code field, and a two-page flow that throws away the first
 * page on a back button is the most common way a sign-in loses somebody.
 *
 * There is no password anywhere. Nothing to forget, nothing to leak, and one
 * fewer field on the first screen a customer ever sees.
 */
export function SignInForm({ next }: { next?: string }) {
  const [requestState, request, requesting] = useActionState(requestShopOtpAction, idleState)
  const [verifyState, verify, verifying] = useActionState(verifyShopOtpAction, idleState)
  const codeSent = requestState.status === 'ok'

  return (
    <div className="signin">
      <form action={request} className="signin__step">
        <label htmlFor="mobile">شمارهٔ موبایل</label>
        <input
          id="mobile"
          name="mobileE164"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="۰۹۱۲۱۲۳۴۵۶۷"
          required
        />
        <button type="submit" className="an-button" disabled={requesting}>
          {requesting ? 'در حال ارسال…' : codeSent ? 'ارسال دوبارهٔ کد' : 'دریافت کد تأیید'}
        </button>
        {requestState.message && (
          <p className={`signin__note signin__note--${requestState.status}`}>
            {requestState.message}
          </p>
        )}
      </form>

      <form action={verify} className={`signin__step${codeSent ? '' : ' is-waiting'}`}>
        {/* Where to land after signing in. Validated server-side before use. */}
        {next && <input type="hidden" name="next" value={next} />}
        <label htmlFor="code">کد تأیید</label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="------"
          className="signin__code"
          disabled={!codeSent}
          required
        />
        <button type="submit" className="an-button" disabled={!codeSent || verifying}>
          {verifying ? 'در حال بررسی…' : 'ورود'}
          <ChevronIcon width={18} height={18} />
        </button>
        {verifyState.message && (
          <p className={`signin__note signin__note--${verifyState.status}`}>
            {verifyState.message}
          </p>
        )}
      </form>

      <p className="signin__reassure">
        <ShieldIcon width={16} height={16} />
        کد فقط چند دقیقه معتبر است و تعداد تلاش‌ها محدود می‌شود.
      </p>
    </div>
  )
}
