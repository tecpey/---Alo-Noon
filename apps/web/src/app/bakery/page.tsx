import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  isUnauthenticated,
  readBranchContext,
  readBranchQueue,
  type BranchContextSummary,
  type BranchOrderSummary,
} from '../../lib/admin-api'
import { branchOrderStepAction, branchProductionAction } from '../../lib/admin-actions'
import {
  availableProductionSteps,
  formatCount,
  formatDateTime,
  formatMoney,
  label,
  ORDER_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  PRODUCTION_STATE_LABELS,
} from '../../lib/admin-format-display'
import { ActionForm, SelectField } from '../admin/action-form'
import { BakeryNav } from './bakery-nav'
import { branchFailureMessage } from './failure-message'

export const dynamic = 'force-dynamic'

/**
 * The counter.
 *
 * One screen, ordered the way the morning goes: what is waiting to be accepted,
 * what is being baked, what is ready to hand over. Every card carries the steps
 * that are actually available from where the order stands, so the person behind
 * the counter never has to know the state machine — the buttons are the state
 * machine.
 */
export default async function BakeryQueuePage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const requested = Array.isArray(params['scope']) ? params['scope'][0] : params['scope']
  const scope = requested === 'ALL' ? 'ALL' : 'LIVE'

  const [context, queue] = await Promise.all([readBranchContext(), readBranchQueue(scope)])
  if (!context.ok && isUnauthenticated(context.error)) redirect('/bakery/login')

  return (
    <main className="admin">
      <BakeryNav active="/bakery" title="صف سفارش‌ها" branches={context.ok ? context.data : []} />

      {!context.ok && <p className="error-box">{branchFailureMessage(context.error.code)}</p>}

      <nav className="range-picker" aria-label="نمایش صف">
        <Link
          href="/bakery"
          className={scope === 'LIVE' ? 'current' : ''}
          aria-current={scope === 'LIVE' ? 'page' : undefined}
        >
          در جریان
        </Link>
        <Link
          href="/bakery?scope=ALL"
          className={scope === 'ALL' ? 'current' : ''}
          aria-current={scope === 'ALL' ? 'page' : undefined}
        >
          همه
        </Link>
      </nav>

      {queue.ok ? (
        <Queue orders={queue.data} branches={context.ok ? context.data : []} />
      ) : (
        <p className="error-box">{branchFailureMessage(queue.error.code)}</p>
      )}
    </main>
  )
}

function Queue({
  orders,
  branches,
}: Readonly<{ orders: BranchOrderSummary[]; branches: BranchContextSummary[] }>) {
  if (orders.length === 0) {
    return <p className="muted">هیچ سفارشی در این نما نیست.</p>
  }
  const branchName = new Map(branches.map((branch) => [branch.branchId, branch.branchNameFa]))
  const manyBranches = branches.length > 1

  return (
    <section className="order-cards">
      {orders.map((order) => (
        <article key={order.id} className="card order-card">
          <header>
            <div>
              <h2 dir="ltr">{order.publicId}</h2>
              <p className="muted">
                {order.recipientNameSnapshot} — {formatCount(order.itemCount)} قلم
                {manyBranches && ` — ${branchName.get(order.branchId) ?? ''}`}
              </p>
            </div>
            <div className="order-states">
              <span className="pill">{label(ORDER_STATE_LABELS, order.state)}</span>
              <span className="pill">{label(PAYMENT_STATE_LABELS, order.paymentState)}</span>
              <span className="pill">{label(PRODUCTION_STATE_LABELS, order.productionState)}</span>
            </div>
          </header>

          <ul className="order-lines">
            {order.items.map((item, index) => (
              <li key={`${order.id}-${index}`}>
                <span>
                  {item.productNameFa} — {item.variantNameFa}
                </span>
                <span>×{formatCount(item.quantity)}</span>
              </li>
            ))}
          </ul>

          <dl className="row-meta">
            <div>
              <dt>سهم نان</dt>
              {/* The subtotal, not the total: the delivery fee is the courier's
                  and the customer's business, not the baker's. */}
              <dd>{formatMoney(order.subtotalAmount)}</dd>
            </div>
            <div>
              <dt>زمان تحویل</dt>
              <dd>{formatDateTime(order.requestedDeliveryAt)}</dd>
            </div>
            <div>
              <dt>ثبت سفارش</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
            </div>
          </dl>

          <Steps order={order} />
        </article>
      ))}
    </section>
  )
}

function Steps({ order }: Readonly<{ order: BranchOrderSummary }>) {
  const production = availableProductionSteps(order.productionState)

  return (
    <div className="order-actions">
      {order.state === 'PENDING_CONFIRMATION' && (
        <>
          {order.paymentState === 'PAID' ? (
            <ActionForm action={branchOrderStepAction} submitLabel="پذیرش سفارش">
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="step" value="accept" />
            </ActionForm>
          ) : (
            // Accepting commits the bakery to bake. Doing it before the money
            // arrived is the mistake the API refuses, and saying so here is
            // kinder than a button that fails.
            <p className="muted">تا وقتی پرداخت مشتری تأیید نشده، پذیرش ممکن نیست.</p>
          )}
          <ActionForm action={branchOrderStepAction} submitLabel="رد سفارش">
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="step" value="reject" />
          </ActionForm>
        </>
      )}

      {order.state === 'CONFIRMED' && (
        <ActionForm action={branchOrderStepAction} submitLabel="تحویل به پیک">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="hidden" name="step" value="start-fulfillment" />
        </ActionForm>
      )}

      {production.length > 0 && (
        <ActionForm action={branchProductionAction} submitLabel="ثبت وضعیت تولید">
          <input type="hidden" name="orderId" value={order.id} />
          <SelectField
            label="وضعیت تولید"
            name="to"
            options={production.map((state) => ({
              value: state,
              label: label(PRODUCTION_STATE_LABELS, state),
            }))}
          />
        </ActionForm>
      )}
    </div>
  )
}
