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
import {
  isUnauthenticated,
  listBranchQuality,
  readSalesReport,
  type BranchQuality,
  type SalesReport,
} from '../../lib/admin-api'
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
  const [report, quality] = await Promise.all([
    readSalesReport(range.from, range.to),
    listBranchQuality(),
  ])

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

      {quality.ok && quality.data.length > 0 && <BranchQualityPanel rows={quality.data} />}
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

/**
 * What customers are saying about each bakery's bread.
 *
 * A flag here means "go and look", never "this bakery is suspended". Ending a
 * partnership on a handful of scores is a decision that has to have a person's
 * name against it, so the panel points and the operator decides.
 *
 * Only branches customers have actually said something about get a row. A
 * branch with no ratings is not news — it is the ordinary state of most of the
 * list — and a panel that gives each of them a card is a panel where the one
 * bakery worth looking at scrolls off the top. The count of silent branches is
 * kept, as a line, because "nobody has rated forty of our bakeries" is worth
 * knowing once and not forty times.
 */
const QUALITY_ROWS_SHOWN = 12

function BranchQualityPanel({ rows }: Readonly<{ rows: readonly BranchQuality[] }>) {
  const flagged = rows.filter((row) => row.flagForReview)
  const silent = rows.filter((row) => row.sampleSize === 0 && !row.flagForReview).length
  // Anything needing attention first, then the lowest scores — the point of the
  // panel is to answer "whose bread should I go and taste this morning", and
  // that is the bottom of the list, not the top.
  const ordered = rows
    .filter((row) => row.sampleSize > 0 || row.flagForReview)
    .sort((left, right) => {
      if (left.flagForReview !== right.flagForReview) return left.flagForReview ? -1 : 1
      if (left.averageHundredths !== right.averageHundredths)
        return left.averageHundredths - right.averageHundredths
      return right.sampleSize - left.sampleSize
    })
  const shown = ordered.slice(0, QUALITY_ROWS_SHOWN)
  const hidden = ordered.length - shown.length

  return (
    <section>
      <h2>کیفیت نان نانوایی‌ها</h2>
      <p className="muted">
        میانگین امتیاز نان در ۹۰ روز گذشته. تا وقتی حداقل ۱۰ امتیاز ثبت نشده باشد، هیچ شعبه‌ای
        علامت‌دار نمی‌شود — یک صبح بد و دو نظر، قضاوت دربارهٔ یک شریک نیست.
      </p>

      {flagged.length > 0 && (
        <p className="error-box">
          {flagged.length.toLocaleString('fa-IR')} شعبه به بررسی نیاز دارد:{' '}
          {flagged.map((row) => `${row.bakeryNameFa} — ${row.branchNameFa}`).join('، ')}
        </p>
      )}

      <ul className="rows">
        {shown.map((row) => (
          <li key={row.bakeryBranchId} className="row">
            <div className="row-head">
              <h3>
                {row.bakeryNameFa} — {row.branchNameFa}
              </h3>
              <strong className={row.flagForReview ? 'bad' : undefined}>
                {row.sampleSize === 0
                  ? '—'
                  : (row.averageHundredths / 100).toLocaleString('fa-IR', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
              </strong>
            </div>
            <p className="muted">
              {row.sampleSize === 0
                ? 'هنوز امتیازی ثبت نشده.'
                : `${row.sampleSize.toLocaleString('fa-IR')} امتیاز`}
              {row.flagForReview && ' · نیاز به بررسی'}
            </p>
          </li>
        ))}
      </ul>

      {ordered.length === 0 && <p className="muted">هنوز هیچ مشتری‌ای به نان امتیاز نداده است.</p>}

      {(hidden > 0 || silent > 0) && (
        <p className="muted">
          {hidden > 0 && `${hidden.toLocaleString('fa-IR')} شعبهٔ امتیازخورده در این فهرست نیامده`}
          {hidden > 0 && silent > 0 && ' · '}
          {silent > 0 && `${silent.toLocaleString('fa-IR')} شعبه هنوز هیچ امتیازی ندارد`}
        </p>
      )}
    </section>
  )
}
