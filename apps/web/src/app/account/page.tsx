import type { Metadata } from 'next'
import Link from 'next/link'

import '../storefront.css'
import './account.css'

import { BrandMark } from '../components/brand-mark'
import { CourierIcon, ReceiptIcon, ShieldIcon } from '../components/icons'

export const metadata: Metadata = {
  title: 'حساب کاربری | الو نون',
  description: 'ورود با کد یک‌بارمصرف و پیگیری سفارش‌ها',
}

/**
 * The account entry.
 *
 * It exists because the header links here, and a header whose links 404 is not
 * a header anybody should ship. What it deliberately does not contain is a
 * sign-in form: customer sign-in is a one-time code, the endpoints for it are
 * real and the mobile app already uses them, and this page is not wired to
 * them yet. A phone field that accepted a number and did nothing would be worse
 * than this page — it would waste a customer's time and then lose their trust
 * for every other control on the site.
 *
 * So it says what is true, and points at the two places that work.
 */
export default function AccountPage() {
  return (
    <div className="app-frame account">
      <header className="account__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
      </header>

      <main className="account__body">
        <h1>ورود به حساب</h1>
        <p className="account__lead">
          ورود با شمارهٔ موبایل و کد یک‌بارمصرف انجام می‌شود؛ رمز عبوری وجود ندارد که فراموش شود.
        </p>

        <ul className="account__points">
          <li>
            <span className="trust__glyph">
              <ShieldIcon duotone width={22} height={22} />
            </span>
            <div>
              <p className="trust__title">کد یک‌بارمصرف، بدون رمز</p>
              <p className="trust__body">
                کد فقط برای مدت کوتاهی معتبر است و تعداد تلاش‌ها محدود می‌شود.
              </p>
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
              <p className="trust__title">ثبت سفارش، فعلاً در اپلیکیشن</p>
              <p className="trust__body">
                مسیر کامل سفارش و پرداخت امروز در اپلیکیشن الو نون کار می‌کند؛ همین مسیر در حال
                افزوده‌شدن به وب است.
              </p>
            </div>
          </li>
        </ul>

        <Link className="an-button" href="/">
          بازگشت به فروشگاه
        </Link>
      </main>
    </div>
  )
}
