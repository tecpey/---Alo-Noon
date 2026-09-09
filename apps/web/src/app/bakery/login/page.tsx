import { cookies } from 'next/headers'

import { requestOtpAction, verifyOtpAction } from '../../../lib/admin-actions'
import { ActionForm, Field } from '../../admin/action-form'

export const dynamic = 'force-dynamic'

export default async function BakeryLoginPage() {
  const cookieStore = await cookies()
  const awaitingCode = Boolean(cookieStore.get('alo_admin_challenge'))

  return (
    <main className="admin-login">
      <h1>ورود کارکنان نانوایی</h1>
      <p className="muted">
        با شمارهٔ موبایلی وارد شوید که دسترسی شعبه روی آن ثبت شده است. اگر مدیر پلتفرم هستید، از{' '}
        <a href="/admin/login">صفحهٔ ورود پنل مدیریت</a> وارد شوید.
      </p>

      <section className="card">
        <h2>۱. دریافت کد تأیید</h2>
        <ActionForm action={requestOtpAction} submitLabel="ارسال کد">
          <Field
            label="شمارهٔ موبایل"
            name="mobileE164"
            required
            dir="ltr"
            inputMode="tel"
            placeholder="+989121234567"
            pattern="\+989[0-9]{9}"
            hint="با قالب +989XXXXXXXXX وارد کنید."
          />
        </ActionForm>
      </section>

      <section className="card">
        <h2>۲. تأیید کد</h2>
        {awaitingCode ? (
          <ActionForm action={verifyOtpAction} submitLabel="ورود">
            <Field
              label="کد شش‌رقمی"
              name="code"
              required
              dir="ltr"
              inputMode="numeric"
              pattern="[0-9]{6}"
            />
            {/* Which panel asked. The action maps this through a fixed list —
                a destination the browser could choose would be an open
                redirect on a sign-in page. */}
            <input type="hidden" name="destination" value="bakery" />
          </ActionForm>
        ) : (
          <p className="muted">ابتدا کد تأیید را درخواست کنید.</p>
        )}
      </section>

      <aside className="note">
        دسترسی شعبه را مدیر پلتفرم برای شمارهٔ شما ثبت می‌کند. اگر بعد از ورود پیام «این حساب
        شعبه‌ای را اداره نمی‌کند» دیدید، یعنی ورودتان درست بوده و فقط دسترسی هنوز ثبت نشده است.
      </aside>
    </main>
  )
}
