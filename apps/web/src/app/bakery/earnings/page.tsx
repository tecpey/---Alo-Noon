import { redirect } from 'next/navigation'

import { formatBasisPoints } from '@alo-noon/domain'

import {
  isUnauthenticated,
  readBranchContext,
  readBranchEarnings,
  type BranchEarningsSummary,
} from '../../../lib/admin-api'
import { formatCount, formatDateTime, formatMoney } from '../../../lib/admin-format-display'
import { BakeryNav } from '../bakery-nav'
import { branchFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

/**
 * What the branch has earned, and what has been paid.
 *
 * The commission is shown as its own line rather than netted away. A partner who
 * cannot see what the platform took cannot check it, and a partner who cannot
 * check it eventually assumes the worst — which costs more than the number ever
 * would.
 */
export default async function BakeryEarningsPage() {
  const [context, earnings] = await Promise.all([readBranchContext(), readBranchEarnings()])
  if (!context.ok && isUnauthenticated(context.error)) redirect('/bakery/login')

  const rate = context.ok ? context.data[0]?.commissionBasisPoints : undefined

  return (
    <main className="admin">
      <BakeryNav
        active="/bakery/earnings"
        title="درآمد شعبه"
        branches={context.ok ? context.data : []}
      />

      <aside className="note">
        سهم شما لحظهٔ <strong>تحویل</strong> سفارش محاسبه می‌شود، نه لحظهٔ پرداخت مشتری — تا روی
        نانی که هنوز نرفته، چیزی به حساب کسی نوشته نشود. نرخ کمیسیون روی همان سفارش ذخیره می‌شود، پس
        تغییر نرخ در آینده، سفارش‌های گذشته را دوباره حساب نمی‌کند.
        {/* The same conversion the settlement itself quotes, from the domain,
            so the panel and the partner agreement can never say two numbers. */}
        {rate !== undefined && <> نرخ کمیسیون فعلی: {formatBasisPoints(rate)}.</>}
      </aside>

      {earnings.ok ? (
        <Earnings earnings={earnings.data} />
      ) : (
        <p className="error-box">{branchFailureMessage(earnings.error.code)}</p>
      )}
    </main>
  )
}

function Earnings({ earnings }: Readonly<{ earnings: BranchEarningsSummary }>) {
  return (
    <>
      <section>
        <h2>خلاصه</h2>
        <dl className="row-meta">
          <div>
            <dt>پرداخت‌نشده</dt>
            <dd>{formatMoney(earnings.unpaid)}</dd>
          </div>
          <div>
            <dt>تعداد سفارش پرداخت‌نشده</dt>
            <dd>{formatCount(earnings.unpaidOrderCount)}</dd>
          </div>
          <div>
            <dt>تسویه‌شده</dt>
            <dd>{formatMoney(earnings.paid)}</dd>
          </div>
          <div>
            <dt>تعداد سفارش تسویه‌شده</dt>
            <dd>{formatCount(earnings.paidOrderCount)}</dd>
          </div>
          <div>
            <dt>کمیسیون پلتفرم</dt>
            <dd>{formatMoney(earnings.commission)}</dd>
          </div>
          <div>
            <dt>قدیمی‌ترین پرداخت‌نشده</dt>
            <dd>{formatDateTime(earnings.oldestUnpaidAt)}</dd>
          </div>
        </dl>
        <p className="muted">
          واریز به‌صورت دوره‌ای و در سطح نانوایی انجام می‌شود، نه سفارش‌به‌سفارش. هر واریز شمارهٔ
          پیگیری بانکی دارد که در صورتحساب بانک شما پیدا می‌شود.
        </p>
      </section>

      <section>
        <h2>سفارش‌های تحویل‌شدهٔ اخیر</h2>
        {earnings.recent.length === 0 ? (
          <p className="muted">هنوز سفارشی تحویل نشده است.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>سفارش</th>
                  <th>تاریخ تحویل</th>
                  <th>مبلغ سفارش</th>
                  <th>کمیسیون</th>
                  <th>سهم شما</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {earnings.recent.map((row) => (
                  <tr key={row.orderId}>
                    <td dir="ltr">{row.publicId}</td>
                    <td>{formatDateTime(row.occurredAt)}</td>
                    <td>{formatMoney(row.total)}</td>
                    <td>{formatMoney(row.commission)}</td>
                    <td>{formatMoney(row.share)}</td>
                    <td>{row.paid ? 'تسویه‌شده' : 'در انتظار واریز'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
