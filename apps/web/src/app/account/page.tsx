import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../storefront.css'
import './account.css'

import { BrandMark } from '../components/brand-mark'
import { CourierIcon, ReceiptIcon, ShieldIcon, UserIcon } from '../components/icons'
import { SignInForm } from './sign-in-form'
import { signOutShopAction } from '../../lib/shop-actions'
import { currentSession } from '../../lib/shop-api'
import { safeNextPath } from '../../lib/safe-next'

export const metadata: Metadata = {
  title: 'حساب کاربری | الو نون',
  description: 'ورود با کد یک‌بارمصرف و پیگیری سفارش‌ها',
}

/**
 * One route, two states.
 *
 * Signed out it is the sign-in screen; signed in it is the account. A separate
 * `/sign-in` route would mean a customer who is already signed in can reach a
 * form that will not help them, and one who is not can reach an account page
 * with nothing in it.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [session, params] = await Promise.all([currentSession(), searchParams])
  const raw = params['next']
  const next = safeNextPath(typeof raw === 'string' ? raw : null, '')

  // Already signed in and on the way somewhere: go, rather than showing an
  // account page they did not ask for and would have to click through.
  if (session && next) redirect(next)

  return (
    <div className="app-frame account">
      <header className="account__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
      </header>

      <main className="account__body">{session ? <SignedIn /> : <SignedOut next={next} />}</main>
    </div>
  )
}

function SignedOut({ next }: { next: string }) {
  return (
    <>
      <h1>ورود به حساب</h1>
      <p className="account__lead">
        ورود با شمارهٔ موبایل و کد یک‌بارمصرف انجام می‌شود؛ رمز عبوری وجود ندارد که فراموش شود.
      </p>
      <SignInForm {...(next && { next })} />
      <ul className="account__points">
        <li>
          <span className="trust__glyph">
            <ShieldIcon duotone width={22} height={22} />
          </span>
          <div>
            <p className="trust__title">کد یک‌بارمصرف، بدون رمز</p>
            <p className="trust__body">کد فقط چند دقیقه معتبر است و تعداد تلاش‌ها محدود می‌شود.</p>
          </div>
        </li>
        <li>
          <span className="trust__glyph">
            <ReceiptIcon duotone width={22} height={22} />
          </span>
          <div>
            <p className="trust__title">پیگیری سفارش تا لحظهٔ تحویل</p>
            <p className="trust__body">وضعیت هر سفارش و سوابق پرداخت در حساب شما می‌ماند.</p>
          </div>
        </li>
        <li>
          <span className="trust__glyph">
            <CourierIcon duotone width={22} height={22} />
          </span>
          <div>
            <p className="trust__title">نشانی‌هایتان ذخیره می‌شود</p>
            <p className="trust__body">
              سفارش بعدی بدون واردکردن دوبارهٔ نشانی و شمارهٔ گیرنده ثبت می‌شود.
            </p>
          </div>
        </li>
      </ul>
    </>
  )
}

/**
 * The signed-in account.
 *
 * It does not show the customer's phone number, because the session the API
 * issues does not contain one — it carries an account id, a customer id and the
 * grants, and nothing else. Printing a number here would mean either fetching
 * something this page has no other reason to fetch, or making one up.
 */
function SignedIn() {
  return (
    <>
      <div className="account__identity">
        <span className="trust__glyph">
          <UserIcon duotone width={22} height={22} />
        </span>
        <div>
          <h1>حساب شما</h1>
          <p className="account__lead">با همان شماره‌ای که کد تأیید را گرفتید وارد شده‌اید.</p>
        </div>
      </div>

      <div className="account__actions">
        <Link className="an-button" href="/orders">
          سفارش‌های من
        </Link>
        <Link className="an-button an-button--quiet" href="/">
          ادامهٔ خرید
        </Link>
      </div>

      <form action={signOutShopAction} className="account__signout">
        <button type="submit" className="an-button an-button--quiet">
          خروج از حساب
        </button>
      </form>
    </>
  )
}
