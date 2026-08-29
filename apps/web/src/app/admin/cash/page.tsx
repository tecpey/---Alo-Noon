import { redirect } from 'next/navigation'

import { recordCashRemittanceAction } from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listCourierCashOrders,
  listCourierCashPositions,
  type CourierCashPosition,
  type OutstandingCashOrder,
} from '../../../lib/admin-api'
import { formatDateTime, formatMoney } from '../../../lib/admin-format-display'
import { ActionForm, Field } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

/**
 * The cash desk.
 *
 * One question, asked every evening by every delivery business that takes cash:
 * how much of today's money is still out on the road, and with whom. Then, when
 * a courier walks in, the counting.
 *
 * The number here is derived from ledger postings rather than kept as a running
 * total against each courier. A stored total eventually disagrees with the books
 * and there is no way to tell which one is lying; a computed one cannot.
 */
export default async function AdminCashPage() {
  const positions = await listCourierCashPositions()
  if (!positions.ok && isUnauthenticated(positions.error)) redirect('/admin/login')

  const carrying: CourierCashPosition[] = positions.ok ? positions.data : []
  // One query per courier, and only for couriers who are actually carrying
  // something. A desk with three couriers at it is three queries; a desk with
  // none is none.
  const orderLists = await Promise.all(
    carrying.map(async (position) => ({
      courierId: position.courierId,
      orders: await listCourierCashOrders(position.courierId),
    })),
  )
  const ordersByCourier = new Map(
    orderLists.map((entry) => [
      entry.courierId,
      entry.orders.ok ? entry.orders.data : ([] as OutstandingCashOrder[]),
    ]),
  )

  const total = carrying.reduce((sum, position) => sum + BigInt(position.outstanding.amount), 0n)

  return (
    <main className="admin">
      <AdminNav
        active="/admin/cash"
        title="صندوق"
        subtitle="پول نقدی که دست پیک‌هاست، و تحویل گرفتنش"
      />

      <aside className="note">
        وقتی مشتری پول را دم در به پیک می‌دهد، سفارش همان لحظه پرداخت‌شده حساب می‌شود — ولی پول هنوز
        به حساب نرسیده، بلکه <em>دست پیک</em> است. این صفحه همان بدهی را نشان می‌دهد. تا وقتی پیک
        پول را تحویل ندهد و اینجا ثبت نشود، آن مبلغ در دفاتر «مطالبات از پیک» می‌ماند.
      </aside>

      <section>
        <h2>مجموع پول در جاده</h2>
        <p className="figure">{formatMoney({ amount: total.toString(), currency: 'IRR' })}</p>
        {!positions.ok && <p className="error-box">{readFailureMessage(positions.error.code)}</p>}
      </section>

      <section>
        <h2>پیک‌ها</h2>
        {carrying.length === 0 ? (
          <p className="muted">
            هیچ پیکی پول نقدی همراهش نیست. یا امروز سفارش نقدی نداشته‌اید، یا همه تحویل داده شده.
          </p>
        ) : (
          <ul className="rows">
            {carrying.map((position) => (
              <CourierCashRow
                key={position.courierId}
                position={position}
                orders={ordersByCourier.get(position.courierId) ?? []}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

/**
 * One courier, what they are carrying, and the form that takes it in.
 *
 * Every order is listed with its own amount and its own checkbox. That is not
 * decoration: a courier who hands over three of their four collections is
 * settling three orders, and a form that could only take "everything" would
 * force the operator to either lie or wait.
 */
function CourierCashRow({
  position,
  orders,
}: {
  position: CourierCashPosition
  orders: readonly OutstandingCashOrder[]
}) {
  return (
    <li className="row">
      <div className="row-head">
        <h3>{position.courierName}</h3>
        <strong>{formatMoney(position.outstanding)}</strong>
      </div>
      <p className="muted">
        {position.orderCount.toLocaleString('fa-IR')} سفارش تحویل‌شده که پولش هنوز نیامده.
      </p>

      {orders.length === 0 ? (
        <p className="muted">فهرست سفارش‌ها در دسترس نیست.</p>
      ) : (
        <ActionForm action={recordCashRemittanceAction} submitLabel="ثبت تحویل وجه">
          <input type="hidden" name="courierId" value={position.courierId} />
          <fieldset className="cash-orders">
            <legend>کدام سفارش‌ها تسویه می‌شود؟</legend>
            {orders.map((order) => (
              <label key={order.orderId} className="cash-order">
                {/* Checked by default: the ordinary case is a courier handing
                    in everything, and making the operator tick four boxes to
                    do the usual thing is how a desk gets slow. */}
                <input type="checkbox" name="orderIds" value={order.orderId} defaultChecked />
                <span className="cash-order__code">{order.publicId}</span>
                <span className="cash-order__when">{formatDateTime(order.collectedAt)}</span>
                <span className="cash-order__amount">{formatMoney(order.amount)}</span>
              </label>
            ))}
          </fieldset>
          <Field
            label="مبلغ شمرده‌شده (ریال)"
            name="declaredAmount"
            required
            hint="همان چیزی که روی میز شمردید. اگر با جمع سفارش‌های تیک‌خورده نخواند، هیچ ثبتی انجام نمی‌شود."
          />
        </ActionForm>
      )}
    </li>
  )
}
