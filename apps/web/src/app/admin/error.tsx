'use client'

/**
 * Where an operator screen that threw lands.
 *
 * Same reasoning as the storefront's, with one difference that matters: the
 * person reading this is at work, mid-task, and probably on the phone to a
 * customer or a bakery. So it says which screen failed to load and offers the
 * retry first, rather than walking them back to a dashboard they did not ask
 * for.
 *
 * The digest is the operator's half of a support ticket. Without it, "the
 * settlement page broke" is unmatchable against a day of server logs.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="admin">
      <h1 className="admin-title">این صفحه بارگذاری نشد</h1>
      <div className="card">
        <p className="error-box">
          خطایی سمت سرور رخ داد و این صفحه ساخته نشد. هیچ داده‌ای تغییر نکرده است؛ عملیاتی که ثبت
          نشده باشد انجام نشده.
        </p>
        <p className="note">
          یک‌بار دیگر تلاش کنید. اگر تکرار شد، کد پیگیری زیر را به تیم فنی بدهید.
        </p>
        <div className="order-actions">
          <button type="button" onClick={reset}>
            تلاش دوباره
          </button>
        </div>
        {error.digest ? (
          <p className="muted">
            کد پیگیری: <code dir="ltr">{error.digest}</code>
          </p>
        ) : null}
      </div>
    </main>
  )
}
