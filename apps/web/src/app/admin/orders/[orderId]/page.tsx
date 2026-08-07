import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  DELIVERY_STATE_LABELS,
  formatCount,
  formatDateTime,
  formatMoney,
  label,
  ORDER_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  PRODUCTION_STATE_LABELS,
} from '../../../../lib/admin-format-display'
import { isUnauthenticated, readOrder } from '../../../../lib/admin-api'
import { AdminNav } from '../../admin-nav'
import { readFailureMessage } from '../../failure-message'

export const dynamic = 'force-dynamic'

export default async function AdminOrderDetailPage({
  params,
}: Readonly<{ params: Promise<{ orderId: string }> }>) {
  const { orderId } = await params
  const result = await readOrder(orderId)
  if (!result.ok && isUnauthenticated(result.error)) redirect('/admin/login')

  if (!result.ok) {
    return (
      <main className="admin">
        <AdminNav active="/admin/orders" title="سفارش" />
        <p className="error-box">{readFailureMessage(result.error.code)}</p>
        <Link href="/admin/orders">بازگشت به فهرست</Link>
      </main>
    )
  }

  const order = result.data
  return (
    <main className="admin">
      <AdminNav
        active="/admin/orders"
        title={`سفارش ${order.publicId}`}
        subtitle={`${label(ORDER_STATE_LABELS, order.state)} — ${formatDateTime(order.createdAt)}`}
      />

      <section className="tiles">
        <Tile label="وضعیت سفارش" value={label(ORDER_STATE_LABELS, order.state)} />
        <Tile label="پرداخت" value={label(PAYMENT_STATE_LABELS, order.paymentState)} />
        <Tile label="تولید" value={label(PRODUCTION_STATE_LABELS, order.productionState)} />
        <Tile label="تحویل" value={label(DELIVERY_STATE_LABELS, order.deliveryState)} />
      </section>

      <div className="split">
        <section className="card">
          <h2>گیرنده و تحویل</h2>
          <dl className="row-meta">
            <div>
              <dt>نام گیرنده</dt>
              <dd>{order.recipientNameSnapshot}</dd>
            </div>
            <div>
              <dt>شمارهٔ تماس</dt>
              <dd dir="ltr">{order.recipientPhoneSnapshot}</dd>
            </div>
            <div>
              <dt>نشانی</dt>
              <dd>{order.deliveryAddressSnapshot}</dd>
            </div>
            <div>
              <dt>زمان درخواستی</dt>
              <dd>{formatDateTime(order.requestedDeliveryAt)}</dd>
            </div>
            {order.deliveryInstructionsSnapshot && (
              <div>
                <dt>توضیح تحویل</dt>
                <dd>{order.deliveryInstructionsSnapshot}</dd>
              </div>
            )}
            {order.customerNotes && (
              <div>
                <dt>یادداشت مشتری</dt>
                <dd>{order.customerNotes}</dd>
              </div>
            )}
            {order.cancellationReasonCode && (
              <div>
                <dt>دلیل لغو</dt>
                <dd dir="ltr">{order.cancellationReasonCode}</dd>
              </div>
            )}
          </dl>
          <p className="muted">
            این مقادیر «عکس لحظه‌ای» زمان ثبت سفارش‌اند؛ تغییر بعدی نشانی یا نام مشتری آن‌ها را عوض
            نمی‌کند.
          </p>
        </section>

        <section className="card">
          <h2>مبالغ</h2>
          <table>
            <tbody>
              <tr>
                <th>جمع اقلام</th>
                <td>{formatMoney(order.subtotalAmount)}</td>
              </tr>
              <tr>
                <th>کرایهٔ تحویل</th>
                <td>{formatMoney(order.deliveryFeeAmount)}</td>
              </tr>
              <tr>
                <th>تخفیف</th>
                <td>{formatMoney(order.discountAmount)}</td>
              </tr>
              <tr>
                <th>مبلغ کل</th>
                <td>
                  <strong>{formatMoney(order.totalAmount)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2>اقلام ({formatCount(order.itemCount)})</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>محصول</th>
                <th>کد</th>
                <th>تعداد</th>
                <th>قیمت واحد</th>
                <th>جمع</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr key={`${item.sku}-${index}`}>
                  <td>
                    {item.productNameFa} — {item.variantNameFa}
                  </td>
                  <td dir="ltr">{item.sku}</td>
                  <td>{formatCount(item.quantity)}</td>
                  <td>{formatMoney(item.unitPrice)}</td>
                  <td>{formatMoney(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>تاریخچهٔ وضعیت</h2>
        {order.transitions.length === 0 ? (
          <p className="muted">تغییر وضعیتی ثبت نشده است.</p>
        ) : (
          <ol className="timeline">
            {order.transitions.map((transition, index) => (
              <li key={`${transition.occurredAt}-${index}`}>
                <span>{formatDateTime(transition.occurredAt)}</span>
                <strong>
                  {transition.fromState
                    ? `${label(ORDER_STATE_LABELS, transition.fromState)} ← `
                    : ''}
                  {label(ORDER_STATE_LABELS, transition.toState)}
                </strong>
                {transition.reasonCode && <small dir="ltr">{transition.reasonCode}</small>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <Link href="/admin/orders">بازگشت به فهرست</Link>
    </main>
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
