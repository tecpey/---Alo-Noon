import { redirect } from 'next/navigation'

import {
  isUnauthenticated,
  readOpenWithdrawals,
  readOutstandingBalances,
  readPartnerPayouts,
  type PartnerBalanceSummary,
  type PartnerPayoutSummary,
  type StaffWithdrawalSummary,
} from '../../../lib/admin-api'
import {
  markPayoutPaidAction,
  payWithdrawalAction,
  preparePayoutAction,
  rejectWithdrawalAction,
} from '../../../lib/admin-actions'
import { formatCount, formatDateTime, formatMoney } from '../../../lib/admin-format-display'
import { ActionForm, Field } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

const PARTY_LABELS: Readonly<Record<string, string>> = {
  BAKERY: 'نانوایی',
  COURIER: 'شرکت پیک',
}

const PAYOUT_STATE_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'در انتظار واریز',
  PAID: 'واریز شده',
  CANCELLED: 'لغو شده',
}

/**
 * How long a partner has been waiting before the page says so out loud.
 *
 * A total alone hides the thing that actually damages a partnership: two
 * bakeries owed the same amount are in very different positions if one has been
 * waiting since last month. Two weeks is the point at which a baker starts
 * asking.
 */
const OVERDUE_DAYS = 14

export default async function AdminSettlementPage() {
  const [balances, payouts, withdrawals] = await Promise.all([
    readOutstandingBalances(),
    readPartnerPayouts(50),
    readOpenWithdrawals(),
  ])
  if (!balances.ok && isUnauthenticated(balances.error)) redirect('/admin/login')

  return (
    <main className="admin">
      <AdminNav
        active="/admin/settlement"
        title="تسویه با شرکا"
        subtitle="سهم نانوایی‌ها و شرکت‌های پیک از سفارش‌های تحویل‌شده، و برگه‌های واریز"
      />

      <aside className="note">
        سهم هر شریک لحظهٔ <strong>تحویل</strong> سفارش محاسبه می‌شود، نه لحظهٔ پرداخت مشتری — تا
        درآمدی روی نانی که هنوز از تنور بیرون نیامده ثبت نشود. نرخ کمیسیون و سهم پیک روی همان سفارش
        کپی می‌شود، پس تغییر نرخ در اسفند، تسویهٔ بهمن را دوباره حساب نمی‌کند.
      </aside>

      <section>
        <h2>مانده‌های پرداخت‌نشده</h2>
        {balances.ok ? (
          <OutstandingTable balances={balances.data} />
        ) : (
          <p className="error-box">{readFailureMessage(balances.error.code)}</p>
        )}
      </section>

      <section>
        <h2>برگه‌های تسویه</h2>
        <p className="muted">
          ساختن برگه، سهم‌های پرداخت‌نشده را همان لحظه قفل و سند تسویه را در دفتر کل ثبت می‌کند.
          واریز را خودتان در بانک انجام می‌دهید؛ این‌جا فقط شمارهٔ پیگیری‌اش ثبت می‌شود. هیچ‌جای این
          سامانه به حساب بانکی شما دسترسی ندارد.
        </p>
        {payouts.ok ? (
          <PayoutTable payouts={payouts.data} />
        ) : (
          <p className="error-box">{readFailureMessage(payouts.error.code)}</p>
        )}
      </section>

      <section>
        <h2>برداشت مشتری‌ها</h2>
        <p className="muted">
          مبلغ در همان لحظهٔ درخواست از کیف پول مشتری کم شده است، پس تا وقتی این‌جا تعیین تکلیف نشود
          پول در دست هیچ‌کس نیست. واریز را خودتان در بانک انجام می‌دهید و شمارهٔ پیگیری را این‌جا
          ثبت می‌کنید؛ اگر رد کنید، مبلغ همان لحظه به کیف پول مشتری برمی‌گردد و دلیلی که می‌نویسید
          را خودِ مشتری می‌خواند.
        </p>
        {withdrawals.ok ? (
          <WithdrawalTable withdrawals={withdrawals.data} />
        ) : (
          <p className="error-box">{readFailureMessage(withdrawals.error.code)}</p>
        )}
      </section>
    </main>
  )
}

function OutstandingTable({ balances }: Readonly<{ balances: PartnerBalanceSummary[] }>) {
  if (balances.length === 0) {
    return <p className="muted">هیچ سهم پرداخت‌نشده‌ای باقی نمانده است.</p>
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>طرف حساب</th>
            <th>نام</th>
            <th>مبلغ</th>
            <th>تعداد سفارش</th>
            <th>قدیمی‌ترین</th>
            <th>اقدام</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((balance) => {
            const overdue = waitingDays(balance.oldestAt) >= OVERDUE_DAYS
            return (
              <tr key={`${balance.party}-${balance.partnerId}`}>
                <td>{PARTY_LABELS[balance.party] ?? balance.party}</td>
                <td>{balance.partnerName}</td>
                <td>{formatMoney(balance.amount)}</td>
                <td>{formatCount(balance.orderCount)}</td>
                <td>
                  {formatDateTime(balance.oldestAt)}
                  {overdue && <strong className="overdue"> — بیش از دو هفته</strong>}
                </td>
                <td>
                  <ActionForm action={preparePayoutAction} submitLabel="ساخت برگهٔ تسویه">
                    <input type="hidden" name="party" value={balance.party} />
                    <input type="hidden" name="partnerId" value={balance.partnerId} />
                  </ActionForm>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PayoutTable({ payouts }: Readonly<{ payouts: PartnerPayoutSummary[] }>) {
  if (payouts.length === 0) {
    return <p className="muted">هنوز هیچ برگهٔ تسویه‌ای ساخته نشده است.</p>
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>طرف حساب</th>
            <th>نام</th>
            <th>مبلغ</th>
            <th>سفارش</th>
            <th>بازه</th>
            <th>وضعیت</th>
            <th>پیگیری بانک</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((payout) => (
            <tr key={payout.id}>
              <td>{PARTY_LABELS[payout.party] ?? payout.party}</td>
              <td>{payout.partnerName}</td>
              <td>{formatMoney(payout.amount)}</td>
              <td>{formatCount(payout.orderCount)}</td>
              <td>
                {formatDateTime(payout.periodStart)} تا {formatDateTime(payout.periodEnd)}
              </td>
              <td>{PAYOUT_STATE_LABELS[payout.state] ?? payout.state}</td>
              <td>
                {payout.state === 'DRAFT' ? (
                  <ActionForm action={markPayoutPaidAction} submitLabel="ثبت واریز">
                    <input type="hidden" name="payoutId" value={payout.id} />
                    <Field
                      label="شمارهٔ پیگیری بانک"
                      name="bankReference"
                      required
                      dir="ltr"
                      hint="همان چیزی که در صورتحساب بانک می‌بینید."
                    />
                  </ActionForm>
                ) : (
                  <span dir="ltr">{payout.bankReference ?? '—'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WithdrawalTable({ withdrawals }: Readonly<{ withdrawals: StaffWithdrawalSummary[] }>) {
  if (withdrawals.length === 0) {
    return <p className="muted">هیچ درخواست برداشتی در انتظار بررسی نیست.</p>
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>مشتری</th>
            <th>مبلغ</th>
            <th>کارت</th>
            <th>شبا</th>
            <th>درخواست</th>
            <th>ثبت واریز</th>
            <th>رد درخواست</th>
          </tr>
        </thead>
        <tbody>
          {withdrawals.map((withdrawal) => {
            const waiting = waitingDays(withdrawal.requestedAt)
            return (
              <tr key={withdrawal.id}>
                <td dir="ltr">{withdrawal.customerMobileE164}</td>
                <td>{formatMoney(withdrawal.amount)}</td>
                <td>
                  {/* Four digits and the holder's name: everything a bank
                      transfer form needs, and nothing a leak could use. */}
                  <span dir="ltr">**** {withdrawal.cardLastFour}</span>
                  <br />
                  <small>{withdrawal.cardHolderName}</small>
                </td>
                <td dir="ltr">{withdrawal.iban ?? '—'}</td>
                <td>
                  {formatDateTime(withdrawal.requestedAt)}
                  {waiting >= 3 && (
                    <strong className="overdue"> — {formatCount(waiting)} روز</strong>
                  )}
                </td>
                <td>
                  <ActionForm action={payWithdrawalAction} submitLabel="ثبت واریز">
                    <input type="hidden" name="withdrawalId" value={withdrawal.id} />
                    <Field
                      label="شمارهٔ پیگیری بانک"
                      name="bankReference"
                      required
                      dir="ltr"
                      hint="همان چیزی که در صورتحساب بانک می‌بینید."
                    />
                  </ActionForm>
                </td>
                <td>
                  <ActionForm action={rejectWithdrawalAction} submitLabel="رد درخواست">
                    <input type="hidden" name="withdrawalId" value={withdrawal.id} />
                    <Field
                      label="دلیل رد"
                      name="reason"
                      required
                      hint="مشتری همین متن را می‌بیند."
                    />
                  </ActionForm>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Whole days since an instant, or 0 when there is nothing to have waited for. */
function waitingDays(oldestAt: string | null): number {
  if (!oldestAt) return 0
  const elapsed = Date.now() - new Date(oldestAt).getTime()
  return elapsed > 0 ? Math.floor(elapsed / 86_400_000) : 0
}
