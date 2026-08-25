import { redirect } from 'next/navigation'

import {
  createCourierAction,
  offerDeliveryAction,
  releaseDeliveryAction,
  setCourierStatusAction,
} from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listCouriers,
  listDeliveries,
  type CourierSummary,
  type DeliveryTask,
} from '../../../lib/admin-api'
import { formatDateTime, formatMoney } from '../../../lib/admin-format-display'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

const TASK_LABELS: Readonly<Record<string, string>> = {
  UNASSIGNED: 'در صف اعزام',
  ASSIGNMENT_PENDING: 'منتظر پاسخ پیک',
  ASSIGNED: 'پیک پذیرفته',
  PICKED_UP: 'تحویل پیک شده',
  OUT_FOR_DELIVERY: 'در راه',
  DELIVERED: 'تحویل شد',
  FAILED: 'تحویل نشد',
  CANCELLED: 'لغو شد',
}

const COURIER_STATUS_LABELS: Readonly<Record<string, string>> = {
  ONBOARDING: 'در حال ثبت‌نام',
  AVAILABLE: 'فعال',
  UNAVAILABLE: 'در دسترس نیست',
  SUSPENDED: 'معلق',
  OFFBOARDED: 'خارج شده',
}

/**
 * The dispatch board and the courier roster on one screen.
 *
 * They are together because they are one job: a dispatcher looking at an order
 * with nobody to give it to needs to add a courier without leaving the page, and
 * an operator marking someone unavailable needs to see the orders that person is
 * holding first.
 */
export default async function AdminDeliveriesPage() {
  const [deliveries, couriers] = await Promise.all([listDeliveries(), listCouriers()])
  if (
    (!deliveries.ok && isUnauthenticated(deliveries.error)) ||
    (!couriers.ok && isUnauthenticated(couriers.error))
  )
    redirect('/admin/login')

  const roster: CourierSummary[] = couriers.ok ? couriers.data : []
  // Only a courier who is actually working can be offered an order, so the
  // dropdown offers nobody else — the API would refuse the rest anyway.
  const offerable = roster.filter((courier) => courier.status === 'AVAILABLE')

  return (
    <main className="admin">
      <AdminNav
        active="/admin/deliveries"
        title="اعزام پیک"
        subtitle="سفارش‌های پذیرفته‌شده و کسی که آن‌ها را می‌برد"
      />

      <aside className="note">
        هر سفارشی که بپذیرید همین‌جا در صف اعزام ظاهر می‌شود. پیشنهاد به پیک یعنی <em>پیشنهاد</em> —
        تا وقتی پیک قبول نکند، به مشتری گفته نمی‌شود که سفارشش راه افتاده. اگر پیک رد کرد یا جواب
        نداد، سفارش به صف برمی‌گردد و به کس دیگری می‌دهید.
      </aside>

      <section>
        <h2>صف اعزام</h2>
        {deliveries.ok ? (
          deliveries.data.length === 0 ? (
            <p className="muted">هیچ سفارش بازی برای تحویل نیست.</p>
          ) : (
            <ul className="rows">
              {deliveries.data.map((task) => (
                <DeliveryRow key={task.taskId} task={task} offerable={offerable} />
              ))}
            </ul>
          )
        ) : (
          <p className="error-box">{readFailureMessage(deliveries.error.code)}</p>
        )}
      </section>

      <section>
        <h2>پیک‌ها</h2>
        {couriers.ok ? (
          roster.length === 0 ? (
            <p className="muted">هنوز پیکی ثبت نشده. تا پیکی نباشد، سفارشی اعزام نمی‌شود.</p>
          ) : (
            <ul className="rows">
              {roster.map((courier) => (
                <CourierRow key={courier.courierId} courier={courier} />
              ))}
            </ul>
          )
        ) : (
          <p className="error-box">{readFailureMessage(couriers.error.code)}</p>
        )}

        <div className="row">
          <h3>ثبت پیک تازه</h3>
          <p className="muted">
            پیک با همین شماره وارد اپ می‌شود، پس باید شمارهٔ واقعی خودش باشد. پس از ثبت، وضعیتش «در
            حال ثبت‌نام» است و تا فعالش نکنید سفارشی نمی‌گیرد.
          </p>
          <ActionForm action={createCourierAction} submitLabel="ثبت پیک">
            <Field label="نام" name="displayName" required />
            <Field
              label="شمارهٔ موبایل"
              name="mobileE164"
              required
              dir="ltr"
              inputMode="tel"
              placeholder="+989121234567"
              pattern="\+989[0-9]{9}"
            />
          </ActionForm>
        </div>
      </section>
    </main>
  )
}

function DeliveryRow({
  task,
  offerable,
}: Readonly<{ task: DeliveryTask; offerable: CourierSummary[] }>) {
  const waiting = task.state === 'UNASSIGNED' || task.state === 'FAILED'

  return (
    <li className="row">
      <div className="row-head">
        <h3>{task.orderPublicId}</h3>
        <span className="badge">{TASK_LABELS[task.state] ?? task.state}</span>
        {task.attemptCount > 0 && <span className="badge">تلاش {task.attemptCount + 1}ام</span>}
      </div>

      <dl className="row-meta">
        <div>
          <dt>گیرنده</dt>
          <dd>{task.recipientName}</dd>
        </div>
        <div>
          <dt>نشانی</dt>
          <dd>{task.address}</dd>
        </div>
        <div>
          <dt>مبلغ</dt>
          <dd>{formatMoney({ amount: task.totalAmount, currency: 'IRR' })}</dd>
        </div>
        <div>
          <dt>پیک</dt>
          <dd>{task.courier ? task.courier.displayName : '—'}</dd>
        </div>
        {task.deliverBefore && (
          <div>
            <dt>تا ساعت</dt>
            <dd>{formatDateTime(task.deliverBefore)}</dd>
          </div>
        )}
      </dl>

      <div className="row-actions">
        {waiting ? (
          offerable.length === 0 ? (
            <p className="muted">پیک فعالی برای اعزام وجود ندارد.</p>
          ) : (
            <ActionForm action={offerDeliveryAction} submitLabel="پیشنهاد به پیک">
              <input type="hidden" name="taskId" value={task.taskId} />
              <SelectField
                label="پیک"
                name="courierId"
                options={offerable.map((courier) => ({
                  value: courier.courierId,
                  // How loaded someone is, so five orders do not all go to the
                  // first name in the list.
                  label: `${courier.displayName} (${courier.activeTasks} سفارش فعال)`,
                }))}
              />
            </ActionForm>
          )
        ) : null}

        {task.state === 'ASSIGNMENT_PENDING' || task.state === 'ASSIGNED' ? (
          <ActionForm action={releaseDeliveryAction} submitLabel="بازگرداندن به صف">
            <input type="hidden" name="taskId" value={task.taskId} />
            <Field label="دلیل (اختیاری)" name="reason" placeholder="پیک جواب نداد" />
          </ActionForm>
        ) : null}
      </div>
    </li>
  )
}

function CourierRow({ courier }: Readonly<{ courier: CourierSummary }>) {
  const gone = courier.status === 'OFFBOARDED'

  return (
    <li className="row">
      <div className="row-head">
        <h3>{courier.displayName}</h3>
        <span className={`badge ${courier.status === 'AVAILABLE' ? 'on' : ''}`}>
          {COURIER_STATUS_LABELS[courier.status] ?? courier.status}
        </span>
        <span dir="ltr" className="muted">
          {courier.mobileE164}
        </span>
      </div>

      <p className="muted">
        {courier.activeTasks === 0
          ? 'الان سفارشی دستش نیست.'
          : `${courier.activeTasks} سفارش دستش است.`}
      </p>

      {gone ? (
        <p className="muted">
          این پیک خارج شده. برای بازگشتش دوباره ثبتش کنید — رکورد تازه‌ای ساخته می‌شود.
        </p>
      ) : (
        <ActionForm action={setCourierStatusAction} submitLabel="ثبت وضعیت">
          <input type="hidden" name="courierId" value={courier.courierId} />
          <SelectField
            label="وضعیت"
            name="status"
            defaultValue={courier.status === 'ONBOARDING' ? 'AVAILABLE' : courier.status}
            options={[
              { value: 'AVAILABLE', label: 'فعال — سفارش بگیرد' },
              { value: 'UNAVAILABLE', label: 'در دسترس نیست' },
              { value: 'SUSPENDED', label: 'معلق' },
              { value: 'OFFBOARDED', label: 'خارج شده' },
            ]}
            hint="تا وقتی سفارشی دستش باشد، از چرخه خارج نمی‌شود."
          />
        </ActionForm>
      )}
    </li>
  )
}
