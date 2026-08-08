import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  isUnauthenticated,
  readFinancialReport,
  type FinancialReport,
} from '../../../lib/admin-api'
import {
  formatCount,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  recentRange,
} from '../../../lib/admin-format-display'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

const RANGES = [
  { days: 1, label: '۲۴ ساعت' },
  { days: 7, label: '۷ روز' },
  { days: 30, label: '۳۰ روز' },
  { days: 90, label: '۹۰ روز' },
] as const

const ACCOUNT_TYPE_LABELS: Readonly<Record<string, string>> = {
  ASSET: 'دارایی',
  LIABILITY: 'بدهی',
  EQUITY: 'سرمایه',
  REVENUE: 'درآمد',
  EXPENSE: 'هزینه',
}

const PAYMENT_STATE_LABELS: Readonly<Record<string, string>> = {
  CREATED: 'ایجادشده',
  PENDING: 'در انتظار',
  AUTHORIZED: 'مجاز',
  CAPTURED: 'دریافت‌شده',
  FAILED: 'ناموفق',
}

export default async function AdminFinancePage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const requested = Number(Array.isArray(params['days']) ? params['days'][0] : params['days'])
  const days = RANGES.some((option) => option.days === requested) ? requested : 30
  const range = recentRange(days)
  const report = await readFinancialReport(range.from, range.to)
  if (!report.ok && isUnauthenticated(report.error)) redirect('/admin/login')

  return (
    <main className="admin">
      <AdminNav
        active="/admin/finance"
        title="گزارش مالی"
        subtitle="تراز دفتر کل، تطبیق تسویه و عملکرد درگاه‌ها"
      />

      <nav className="range-picker" aria-label="بازهٔ گزارش">
        {RANGES.map((option) => (
          <Link
            key={option.days}
            href={`/admin/finance?days=${option.days}`}
            className={option.days === days ? 'current' : ''}
            aria-current={option.days === days ? 'page' : undefined}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {report.ok ? (
        <FinancialSections report={report.data} />
      ) : (
        <p className="error-box">{readFailureMessage(report.error.code)}</p>
      )}
    </main>
  )
}

function FinancialSections({ report }: Readonly<{ report: FinancialReport }>) {
  const { trialBalance, settlement, providers } = report
  const gapIsZero = settlement.captureToOrderGap.amount === '0'

  return (
    <>
      {/* The balance check goes first and loudly. If the ledger does not
          balance, nothing below it means anything. */}
      {trialBalance.balanced ? (
        <aside className="note">
          دفتر کل تراز است: جمع بدهکار و بستانکار برابرند. مانده‌ها تجمعی‌اند تا{' '}
          {formatDateTime(trialBalance.asOf)}، نه فقط بازهٔ انتخابی — تراز یک هفته به تنهایی تراز
          نیست.
        </aside>
      ) : (
        <p className="error-box">
          <strong>دفتر کل تراز نیست.</strong> جمع بدهکار {formatMoney(trialBalance.totalDebits)} و
          جمع بستانکار {formatMoney(trialBalance.totalCredits)} است. این نباید ممکن باشد؛ تا
          روشن‌شدن علت، به هیچ عدد دیگری در این صفحه اتکا نکنید.
        </p>
      )}

      <section>
        <h2>تراز آزمایشی</h2>
        {trialBalance.rows.length === 0 ? (
          <p className="muted">هنوز هیچ سندی ثبت نشده است.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>کد حساب</th>
                  <th>نام</th>
                  <th>نوع</th>
                  <th>بدهکار</th>
                  <th>بستانکار</th>
                  <th>مانده</th>
                  <th>تعداد سطر</th>
                </tr>
              </thead>
              <tbody>
                {trialBalance.rows.map((row) => (
                  <tr key={row.accountCode}>
                    <td dir="ltr">{row.accountCode}</td>
                    <td>{row.accountName}</td>
                    <td>{ACCOUNT_TYPE_LABELS[row.accountType] ?? row.accountType}</td>
                    <td>{formatMoney(row.debits)}</td>
                    <td>{formatMoney(row.credits)}</td>
                    <td>{formatSignedMoney(row.balance)}</td>
                    <td>{formatCount(row.entryCount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>جمع</th>
                  <td>{formatMoney(trialBalance.totalDebits)}</td>
                  <td>{formatMoney(trialBalance.totalCredits)}</td>
                  <td colSpan={2}>{trialBalance.balanced ? 'تراز' : 'ناتراز'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted">
          حساب‌هایی که هیچ سندی نخورده‌اند نمایش داده نمی‌شوند؛ نمودار حساب‌ها ده‌ها حساب دارد که یک
          پایلوت هرگز به آن‌ها نمی‌زند.
        </p>
      </section>

      <section>
        <h2>تطبیق تسویه</h2>
        <dl className="row-meta">
          <div>
            <dt>مبلغ دریافت‌شده</dt>
            <dd>{formatMoney(settlement.capturedValue)}</dd>
          </div>
          <div>
            <dt>تعداد دریافت</dt>
            <dd>{formatCount(settlement.capturedCount)}</dd>
          </div>
          <div>
            <dt>سفارش پرداخت‌شده</dt>
            <dd>{formatCount(settlement.paidOrders)}</dd>
          </div>
          <div>
            <dt>ارزش سفارش‌های پرداخت‌شده</dt>
            <dd>{formatMoney(settlement.paidOrderValue)}</dd>
          </div>
        </dl>

        {gapIsZero ? (
          <p className="muted">
            هر ریالی که دریافت شده، سفارشِ متناظرش هم پرداخت‌شده علامت خورده است.
          </p>
        ) : (
          <p className="error-box">
            اختلاف {formatSignedMoney(settlement.captureToOrderGap)} بین پولِ دریافت‌شده و
            سفارش‌هایی که پرداخت‌شده علامت خورده‌اند. یعنی پولی جابه‌جا شده که سمت سفارش آن را
            نمی‌شناسد — همان پنجره‌ای که ترتیب تسویه عمداً قابل‌بازیابی نگه می‌دارد. رسیدهای
            پردازش‌نشده را بررسی کنید.
          </p>
        )}

        <h3>رسیدهای بازگشت از درگاه</h3>
        <dl className="row-meta">
          <div>
            <dt>کل</dt>
            <dd>{formatCount(settlement.receipts.total)}</dd>
          </div>
          <div>
            <dt>تسویه‌شده</dt>
            <dd>{formatCount(settlement.receipts.processed)}</dd>
          </div>
          <div>
            <dt>ردشده (قرنطینه)</dt>
            <dd>{formatCount(settlement.receipts.rejected)}</dd>
          </div>
          <div>
            <dt>در انتظار پردازش</dt>
            <dd>{formatCount(settlement.receipts.awaitingProcessing)}</dd>
          </div>
        </dl>
        {settlement.receipts.awaitingProcessing > 0 && (
          <p className="note">
            قدیمی‌ترین رسید پردازش‌نشده: {formatDateTime(settlement.receipts.oldestAwaitingAt)}.
            جاروب بازیابی هر دقیقه اجرا می‌شود؛ اگر این عدد بالا می‌ماند یعنی درگاه پاسخ نمی‌دهد.
          </p>
        )}
        {settlement.receipts.rejected > 0 && (
          <p className="note">
            رسید ردشده یعنی مبلغ یا ارجاعِ درگاه با آنچه انتظار می‌رفت نخوانده است. هر کدام یا حمله
            است یا اشکال، و هر دو نیاز به بررسی انسان دارند؛ دلیلش زیر رویداد{' '}
            <code dir="ltr">payment.callback_settlement_decided</code> در سابقهٔ ممیزی است.
          </p>
        )}

        <h3>پرداخت‌ها بر اساس وضعیت</h3>
        {Object.keys(settlement.paymentsByState).length === 0 ? (
          <p className="muted">در این بازه پرداختی آغاز نشده است.</p>
        ) : (
          <ul className="bars">
            {Object.entries(settlement.paymentsByState).map(([state, count]) => (
              <li key={state}>
                <span>{PAYMENT_STATE_LABELS[state] ?? state}</span>
                <span className="bar-value">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>عملکرد درگاه‌ها</h2>
        {providers.length === 0 ? (
          <p className="muted">در این بازه هیچ تلاش پرداختی ثبت نشده است.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>درگاه</th>
                  <th>محیط</th>
                  <th>تلاش</th>
                  <th>موفق</th>
                  <th>رد</th>
                  <th>ناموفق</th>
                  <th>در جریان</th>
                  <th>نرخ موفقیت</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((row) => (
                  <tr key={`${row.providerCode}-${row.environment}`}>
                    <td dir="ltr">{row.providerCode}</td>
                    <td>{row.environment === 'PRODUCTION' ? 'عملیاتی' : 'آزمایشی'}</td>
                    <td>{formatCount(row.attempts)}</td>
                    <td>{formatCount(row.verified)}</td>
                    <td>{formatCount(row.rejected)}</td>
                    <td>{formatCount(row.failed)}</td>
                    <td>{formatCount(row.inFlight)}</td>
                    <td>{formatPercent(row.verificationRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          «در جریان» یعنی تلاشی که شروع شده و به وضعیت نهایی نرسیده — یا هنوز در راه است، یا مشتری
          صفحه را بسته. تفکیک بر اساس درگاه و محیط است، نه بر اساس پیکربندی، تا چرخش کلید یک درگاه
          آمارش را دو تکه نکند.
        </p>
      </section>
    </>
  )
}
