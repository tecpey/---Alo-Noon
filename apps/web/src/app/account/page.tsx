import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../storefront.css'
import './account.css'

import { BrandMark } from '../components/brand-mark'
import { CourierIcon, ReceiptIcon, ShieldIcon, UserIcon, WalletIcon } from '../components/icons'
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

/**
 * What this sign-in is *for*, in the words of the thing the customer was doing.
 *
 * Every gated route lands here, and before this they all read «ورود به حساب» —
 * the same four words whether somebody had tapped «ادامهٔ سفارش» with a basket
 * of bread, opened their orders to see where lunch was, or gone looking for
 * their wallet. A screen that cannot say why it is in the way is where the
 * thread of a task gets dropped, and NN/g's senior research is blunt about the
 * cost: after one failure, older customers abandon at nearly twice the rate of
 * younger ones, and are markedly less willing to try another route.
 *
 * Keyed on the destination the route already passes, so a new gated page gets
 * a sentence by adding one line here rather than by being forgotten.
 */
const SIGN_IN_PURPOSE: Readonly<Record<string, { title: string; lead: string }>> = {
  '/checkout': {
    title: 'برای ثبت سفارش وارد شوید',
    lead: 'سبد شما محفوظ است. با شمارهٔ موبایل و یک کد پیامکی وارد شوید تا سفارش را تمام کنیم.',
  },
  '/orders': {
    title: 'برای دیدن سفارش‌ها وارد شوید',
    lead: 'سفارش‌های شما به شمارهٔ موبایلتان بسته است. کد پیامکی را بزنید تا نشانتان بدهیم.',
  },
  '/wallet': {
    title: 'برای دیدن کیف پول وارد شوید',
    lead: 'موجودی و گردش حساب شما به شمارهٔ موبایلتان بسته است.',
  },
}

const DEFAULT_PURPOSE = {
  title: 'ورود به حساب',
  lead: 'ورود با شمارهٔ موبایل و کد یک‌بارمصرف انجام می‌شود؛ رمز عبوری وجود ندارد که فراموش شود.',
} as const

function SignedOut({ next }: { next: string }) {
  const purpose = SIGN_IN_PURPOSE[next] ?? DEFAULT_PURPOSE
  return (
    <>
      <h1>{purpose.title}</h1>
      <p className="account__lead">{purpose.lead}</p>
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
        <li>
          <span className="trust__glyph">
            <WalletIcon duotone width={22} height={22} />
          </span>
          <div>
            <p className="trust__title">کیف پول</p>
            <p className="trust__body">
              یک‌بار شارژ کنید و سفارش‌های بعدی را بدون رفتن به درگاه بانکی پرداخت کنید.
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
        <Link className="an-button an-button--quiet" href="/wallet">
          <WalletIcon width={18} height={18} />
          کیف پول
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
