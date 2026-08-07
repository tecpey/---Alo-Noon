import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  formatCount,
  formatDate,
  formatMoney,
  formatPercent,
  label,
  ORDER_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  recentRange,
} from '../../lib/admin-format-display'
import { isUnauthenticated, readSalesReport, type SalesReport } from '../../lib/admin-api'
import { AdminNav } from './admin-nav'
import { readFailureMessage } from './failure-message'

// Sales figures change with every order, so the page is rendered per request
// rather than served from a build-time snapshot.
export const dynamic = 'force-dynamic'

const RANGES = [
  { days: 1, label: '۲۴ ساعت' },
  { days: 7, label: '۷ روز' },
  { days: 30, label: '۳۰ روز' },
  { days: 90, label: '۹۰ روز' },
] as const

export default async function AdminDashboardPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const requested = Number(Array.isArray(params['days']) ? params['days'][0] : params['days'])
  const days = RANGES.some((range) => range.days === requested) ? requested : 7
  const range = recentRange(days)
  const report = await readSalesReport(range.from, range.to)

  if (!report.ok && isUnauthenticated(report.error)) redirect('/admin/login')

  return (
    <main className="admin">
      <AdminNav active="/admin" title="داشبورد فروش" subtitle="نمای کلی سفارش‌ها و درآمد" />

      <nav className="range-picker" aria-label="بازهٔ گزارش">
        {RANGES.map((option) => (
          <Link
            key={option.days}
            href={`/admin?days=${option.days}`}
            className={option.days === days ? 'current' : ''}
            aria-current={option.days === days ? 'page' : undefined}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {report.ok ? (
        <Dashboard report={report.data} />
      ) : (
        <p className="error-box">{readFailureMessage(report.error.code)}</p>
      )}
    </main>
  )
}

function Dashboard({ report }: Readonly<{ report: SalesReport }>) {
  const { totals, conversion } = report
  const maxDaily = report.daily.reduce((peak, point) => Math.max(peak, point.placedOrders), 0)

  return (
    <>
      <section className="tiles">
        <Tile label="سفارش‌های ثبت‌شده" value={formatCount(totals.placedOrders)} />
        <Tile label="ارزش سفارش‌ها" value={formatMoney(totals.placedValue)} />
        <Tile label="میانگین هر سفارش" value={formatMoney(totals.averageOrderValue)} />
        <Tile
          label="لغوشده"
          value={`${formatCount(totals.cancelledOrders)} — ${formatMoney(totals.cancelledValue)}`}
        />
        <Tile label="کرایهٔ تحویل" value={formatMoney(totals.deliveryFees)} />
        <Tile label="تخفیف‌ها" value={formatMoney(totals.discounts)} />
      </section>

      <aside className="note">
        <strong>دربارهٔ «پرداخت‌شده»:</strong> تا وقتی تأیید و برداشت پرداخت پیاده نشده باشد، هیچ
        سفارشی به وضعیت پرداخت‌شده نمی‌رسد. عدد {formatCount(totals.paidOrders)} که این‌جا می‌بینید
        واقعیت سیستم است، نه خطای گزارش. رقم قابل استناد امروز «ارزش سفارش‌ها» است.
      </aside>

      <section>
        <h2>روند روزانه</h2>
        {report.daily.length === 0 ? (
          <p className="muted">در این بازه سفارشی ثبت نشده است.</p>
        ) : (
          <ol className="bars">
            {report.daily.map((point) => (
              <li key={point.date}>
                <span className="bar-label">{formatDate(point.date)}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{
                      inlineSize: `${maxDaily > 0 ? Math.max(4, (point.placedOrders / maxDaily) * 100) : 0}%`,
                    }}
                  />
                </span>
                <span className="bar-value">
                  {formatCount(point.placedOrders)} — {formatMoney(point.placedValue)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="split">
        <section>
          <h2>پرفروش‌ترین‌ها</h2>
          {report.topProducts.length === 0 ? (
            <p className="muted">فروشی ثبت نشده است.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>محصول</th>
                  <th>تعداد</th>
                  <th>درآمد</th>
                </tr>
              </thead>
              <tbody>
                {report.topProducts.map((product) => (
                  <tr key={product.sku}>
                    <td>
                      {product.productNameFa}
                      <small dir="ltr"> {product.sku}</small>
                    </td>
                    <td>{formatCount(product.quantity)}</td>
                    <td>{formatMoney(product.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2>قیف تبدیل</h2>
          <table>
            <tbody>
              <tr>
                <th>سبد ساخته‌شده</th>
                <td>{formatCount(conversion.carts)}</td>
              </tr>
              <tr>
                <th>پیش‌فاکتور</th>
                <td>{formatCount(conversion.quotes)}</td>
              </tr>
              <tr>
                <th>سفارش</th>
                <td>{formatCount(conversion.orders)}</td>
              </tr>
              <tr>
                <th>نرخ تبدیل پیش‌فاکتور به سفارش</th>
                <td>{formatPercent(conversion.quoteToOrderRate)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <div className="split">
        <StateBreakdown
          heading="وضعیت سفارش"
          counts={report.ordersByState}
          labels={ORDER_STATE_LABELS}
        />
        <StateBreakdown
          heading="وضعیت پرداخت"
          counts={report.ordersByPaymentState}
          labels={PAYMENT_STATE_LABELS}
        />
      </div>
    </>
  )
}

function Tile({ label: name, value }: Readonly<{ label: string; value: string }>) {
  return (
    <article className="tile">
      <span>{name}</span>
      <strong>{value}</strong>
    </article>
  )
}

function StateBreakdown({
  heading,
  counts,
  labels,
}: Readonly<{
  heading: string
  counts: Record<string, number>
  labels: Readonly<Record<string, string>>
}>) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a)
  return (
    <section>
      <h2>{heading}</h2>
      {entries.length === 0 ? (
        <p className="muted">داده‌ای نیست.</p>
      ) : (
        <table>
          <tbody>
            {entries.map(([state, count]) => (
              <tr key={state}>
                <th>{label(labels, state)}</th>
                <td>{formatCount(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
