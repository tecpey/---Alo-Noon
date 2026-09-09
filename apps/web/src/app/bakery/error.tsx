'use client'

/**
 * Where a bakery's screen that threw lands.
 *
 * Its own file rather than falling through to the operator panel's: the two
 * panels are separate route segments, so an error under `/bakery` would
 * otherwise reach the storefront's boundary and hand a baker a shop page with a
 * basket on it, mid-shift.
 *
 * The reassurance is the important sentence. A baker whose queue screen breaks
 * has no way of knowing whether the orders on it are still coming, and the
 * answer — they are, this is only the screen — is the thing they need before
 * anything else.
 */
export default function BakeryError({
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
          خطایی سمت سرور رخ داد و این صفحه ساخته نشد. سفارش‌های شعبه سر جایشان هستند و همچنان ثبت
          می‌شوند؛ فقط این صفحه بالا نیامد.
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
