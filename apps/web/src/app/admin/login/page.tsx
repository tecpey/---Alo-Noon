import { cookies } from 'next/headers'

import { requestOtpAction, verifyOtpAction } from '../../../lib/admin-actions'
import { ActionForm, Field } from '../action-form'

export const dynamic = 'force-dynamic'

export default async function AdminLoginPage() {
  const cookieStore = await cookies()
  const awaitingCode = Boolean(cookieStore.get('alo_admin_challenge'))

  return (
    <main className="admin-login">
      <h1>ورود به پنل مدیریت</h1>
      <p className="muted">
        ورود با شمارهٔ موبایلِ حسابی که دسترسی مدیریت سرویس‌دهنده‌ها روی آن ثبت شده است.
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
          </ActionForm>
        ) : (
          <p className="muted">ابتدا کد تأیید را درخواست کنید.</p>
        )}
      </section>

      <aside className="note">
        <strong>اگر پیامکی دریافت نکردید:</strong> تا وقتی هیچ سرویس پیامکی پیکربندی نشده باشد، ورود
        از این صفحه ممکن نیست. اولین سرویس پیامک و اولین دسترسی مدیریت باید یک‌بار با ابزار خط فرمان
        ساخته شوند؛ مراحل آن در راهنمای بهره‌برداری آمده است.
      </aside>
    </main>
  )
}
