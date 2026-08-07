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
} from '../../../lib/admin-format-display'
import { isUnauthenticated, listOrders } from '../../../lib/admin-api'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20
const STATES = Object.keys(ORDER_STATE_LABELS).filter((state) => state !== 'DRAFT')

function one(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value
  return single && single.trim() ? single.trim() : undefined
}

export default async function AdminOrdersPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const page = Math.max(1, Number(one(params['page']) ?? '1') || 1)
  const state = one(params['state'])
  const search = one(params['search'])

  const query: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) }
  // Only echo back a state the API would accept, so a hand-edited URL cannot
  // turn into a 400 the operator has no way to read.
  if (state && STATES.includes(state)) query['state'] = state
  if (search && search.length >= 3) query['search'] = search

  const result = await listOrders(query)
  if (!result.ok && isUnauthenticated(result.error)) redirect('/admin/login')

  return (
    <main className="admin">
      <AdminNav active="/admin/orders" title="سفارش‌ها" subtitle="جست‌وجو و بررسی سفارش‌ها" />

      <form className="filters" method="get">
        <label className="field">
          <span>وضعیت</span>
          <select name="state" defaultValue={query['state'] ?? ''}>
            <option value="">همه</option>
            {STATES.map((code) => (
              <option key={code} value={code}>
                {label(ORDER_STATE_LABELS, code)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>جست‌وجو</span>
          <input
            name="search"
            dir="ltr"
            defaultValue={query['search'] ?? ''}
            placeholder="شناسهٔ سفارش یا شمارهٔ گیرنده"
          />
          <small>باید دقیقاً برابر باشد؛ جست‌وجوی جزئی پشتیبانی نمی‌شود.</small>
        </label>
        <button type="submit">اعمال</button>
      </form>

      {result.ok ? (
        <>
          {result.data.length === 0 ? (
            <p className="muted">سفارشی با این شرایط پیدا نشد.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>شناسه</th>
                    <th>گیرنده</th>
                    <th>نانوایی</th>
                    <th>وضعیت</th>
                    <th>پرداخت</th>
                    <th>تحویل</th>
                    <th>مبلغ</th>
                    <th>ثبت</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link href={`/admin/orders/${order.id}`} dir="ltr">
                          {order.publicId}
                        </Link>
                      </td>
                      <td>{order.recipientNameSnapshot}</td>
                      <td>{order.bakeryNameSnapshot}</td>
                      <td>{label(ORDER_STATE_LABELS, order.state)}</td>
                      <td>{label(PAYMENT_STATE_LABELS, order.paymentState)}</td>
                      <td>{label(DELIVERY_STATE_LABELS, order.deliveryState)}</td>
                      <td>{formatMoney(order.totalAmount)}</td>
                      <td>{formatDateTime(order.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.pagination && (
            <nav className="pager" aria-label="صفحه‌بندی">
              <span className="muted">
                {formatCount(result.pagination.totalItems)} سفارش، صفحهٔ{' '}
                {formatCount(result.pagination.page)} از{' '}
                {formatCount(Math.max(1, result.pagination.totalPages))}
              </span>
              <span>
                {result.pagination.hasPreviousPage && (
                  <Link href={pageHref(query, page - 1)}>قبلی</Link>
                )}
                {result.pagination.hasNextPage && (
                  <Link href={pageHref(query, page + 1)}>بعدی</Link>
                )}
              </span>
            </nav>
          )}
        </>
      ) : (
        <p className="error-box">{readFailureMessage(result.error.code)}</p>
      )}
    </main>
  )
}

function pageHref(query: Record<string, string>, page: number): string {
  const next = new URLSearchParams(query)
  next.set('page', String(page))
  next.delete('pageSize')
  return `/admin/orders?${next.toString()}`
}
