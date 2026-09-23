'use client'

import { useActionState, useEffect, useRef } from 'react'

import { ChevronIcon, ShieldIcon } from '../components/icons'
import { idleState } from '../../lib/action-state'
import { requestShopOtpAction, verifyShopOtpAction } from '../../lib/shop-actions'

/**
 * Signing in, one step at a time, without ever throwing a step away.
 *
 * It used to show both steps at once, the second dimmed to 55% with its input
 * disabled, on the argument that a customer needs to see the second step
 * coming. That argument is right; a disabled form field is the wrong way to
 * make it. A dead input is the single most reliable way to stall an older
 * customer — NIA's checklist is explicit that a page should carry one task, and
 * NN/g measured that after one failed attempt customers over 65 abandon at
 * roughly twice the rate of younger ones. Somebody who taps a greyed-out box
 * and gets nothing has already had that failure, before the code even arrives.
 *
 * So the promise is kept as a sentence — «کد را همین‌جا وارد می‌کنید» — and the
 * field appears when there is something to type into it.
 *
 * Nothing is thrown away either, which was the other half of the original
 * argument: the number stays on the screen after the code is sent, demoted to a
 * quiet block, so a mistyped digit is fixed and the code resent in place. A
 * two-page flow that loses the first page on a back button is still the most
 * common way a sign-in loses somebody.
 *
 * There is no password anywhere. Nothing to forget, nothing to leak, and one
 * fewer field on the first screen a customer ever sees.
 */
export function SignInForm({ next }: { next?: string }) {
  const [requestState, request, requesting] = useActionState(requestShopOtpAction, idleState)
  const [verifyState, verify, verifying] = useActionState(verifyShopOtpAction, idleState)
  const codeSent = requestState.status === 'ok'
  const codeField = useRef<HTMLInputElement>(null)

  /*
    The field that just appeared is the one the customer is about to use, so it
    gets the cursor. Without this the keyboard closes when the SMS arrives and
    reopening it costs a tap on a target somebody has to find first — and for a
    screen reader, focus landing on the new field is how the new step is
    announced at all.
  */
  useEffect(() => {
    if (codeSent) codeField.current?.focus()
  }, [codeSent])

  const numberStep = (
    <form
      key="number"
      action={request}
      className={`signin__step${codeSent ? ' signin__step--quiet' : ''}`}
    >
      <label htmlFor="mobile">{codeSent ? 'شماره را اشتباه زدید؟' : 'شمارهٔ موبایل'}</label>
      <input
        id="mobile"
        name="mobileE164"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="۰۹۱۲۱۲۳۴۵۶۷"
        required
      />
      <button
        type="submit"
        className={codeSent ? 'an-button an-button--quiet' : 'an-button'}
        disabled={requesting}
      >
        {requesting ? 'در حال ارسال…' : codeSent ? 'ارسال دوبارهٔ کد' : 'دریافت کد تأیید'}
      </button>
      {/*
        Once the code is on its way the confirmation belongs beside the code
        box, not down here under the number. What stays here is the failure —
        a number the gateway refused is a thing to fix on this form.
      */}
      {requestState.message && !codeSent && (
        <p className={`signin__note signin__note--${requestState.status}`} role="alert">
          {requestState.message}
        </p>
      )}
      {!codeSent && <p className="signin__hint">کد پیامکی را در گام بعد، همین‌جا وارد می‌کنید.</p>}
    </form>
  )

  const codeStep = codeSent ? (
    <form key="code" action={verify} className="signin__step">
      {/* Where to land after signing in. Validated server-side before use. */}
      {next && <input type="hidden" name="next" value={next} />}
      <label htmlFor="code">کد تأیید</label>
      {requestState.message && (
        <p className="signin__note signin__note--ok" role="status">
          {requestState.message}
        </p>
      )}
      <input
        ref={codeField}
        id="code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="------"
        className="signin__code"
        required
      />
      <button type="submit" className="an-button" disabled={verifying}>
        {verifying ? 'در حال بررسی…' : 'ورود'}
        <ChevronIcon width={18} height={18} />
      </button>
      {verifyState.message && (
        <p className={`signin__note signin__note--${verifyState.status}`} role="alert">
          {verifyState.message}
        </p>
      )}
    </form>
  ) : null

  return (
    <div className="signin">
      {/* Whichever step is live comes first, so the thing to do is the thing on
          top — for a thumb and for a screen reader alike. */}
      {codeStep}
      {numberStep}

      <p className="signin__reassure">
        <ShieldIcon width={16} height={16} />
        کد فقط چند دقیقه معتبر است و تعداد تلاش‌ها محدود می‌شود.
      </p>
    </div>
  )
}
