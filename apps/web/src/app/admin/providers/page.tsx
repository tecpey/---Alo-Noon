import { redirect } from 'next/navigation'

import {
  createPaymentConfigurationAction,
  createEmailConfigurationAction,
  createPaymentCredentialAction,
  createRoutingConfigurationAction,
  createSmsConfigurationAction,
  governPaymentConfigurationAction,
  setEmailHealthAction,
  setPaymentHealthAction,
  setRoutingHealthAction,
  setSmsHealthAction,
} from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listEmailConfigurations,
  listPaymentConfigurations,
  listRoutingConfigurations,
  listSmsConfigurations,
  type EmailConfigurationSummary,
  type PaymentConfigurationSummary,
  type RoutingConfigurationSummary,
  type SmsConfigurationSummary,
} from '../../../lib/admin-api'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

// Provider state is governance data that changes by operator action, so it is
// read fresh on every request rather than served from a build-time render.
export const dynamic = 'force-dynamic'

const ENVIRONMENTS = [
  { value: 'TEST', label: 'آزمایشی (TEST)' },
  { value: 'PRODUCTION', label: 'عملیاتی (PRODUCTION)' },
]

const HEALTH_LABELS: Readonly<Record<string, string>> = {
  UNKNOWN: 'نامشخص',
  HEALTHY: 'سالم',
  DEGRADED: 'کاهش‌یافته',
  UNHEALTHY: 'ناسالم',
}

export default async function AdminProvidersPage() {
  const [payments, sms, routing, email] = await Promise.all([
    listPaymentConfigurations(),
    listSmsConfigurations(),
    listRoutingConfigurations(),
    listEmailConfigurations(),
  ])

  // The lists themselves are the authorization check. A separate session probe
  // would gate the page on session.self.read, a permission a governance-only
  // operator has no reason to hold — and the page would be unreachable for
  // exactly the accounts it exists for.
  // Routing is deliberately not part of this test. Its permission is separate,
  // so an operator who governs payment and SMS but not routing gets a 403 on
  // that one list — which must render as a message inside the page, not as a
  // bounce to the login screen for someone who is plainly signed in.
  if (
    (!payments.ok && isUnauthenticated(payments.error)) ||
    (!sms.ok && isUnauthenticated(sms.error))
  ) {
    redirect('/admin/login')
  }

  return (
    <main className="admin">
      <AdminNav
        active="/admin/providers"
        title="سرویس‌دهنده‌ها"
        subtitle="درگاه پرداخت، پیامک، ایمیل، و موتور مسیریابی"
      />

      <aside className="note">
        هیچ کلید یا رمزی از این پنل عبور نمی‌کند. آنچه ثبت می‌کنید فقط یک <em>ارجاع</em> به محل
        نگه‌داری کلید است؛ مقدار کلید در محیط اجرا می‌ماند و از این‌جا نه ذخیره می‌شود و نه قابل
        خواندن است.
      </aside>

      <section>
        <h2>درگاه‌های پرداخت</h2>
        {payments.ok ? (
          <PaymentTable configurations={payments.data} />
        ) : (
          <p className="error-box">{readFailureMessage(payments.error.code)}</p>
        )}

        <details className="card">
          <summary>افزودن درگاه جدید</summary>
          <p className="muted">
            سه مرحله پشت سر هم: ثبت ارجاع کلید، ساخت پیکربندی، سپس فعال‌سازی و ثبت سلامت. درگاه تا
            وقتی «سالم» علامت نخورده باشد انتخاب نمی‌شود.
          </p>

          <h3>۱. ثبت ارجاع کلید</h3>
          <ActionForm action={createPaymentCredentialAction} submitLabel="ثبت ارجاع">
            <Field
              label="کد درگاه"
              name="providerCode"
              required
              dir="ltr"
              placeholder="IDPAY"
              hint="با حروف بزرگ لاتین، مطابق آداپتور نصب‌شده."
            />
            <Field
              label="ارجاع کلید"
              name="reference"
              required
              dir="ltr"
              placeholder="local-encrypted://IDPAY"
              hint="یکی از vault:// ، aws-sm:// ، gcp-sm:// یا local-encrypted:// . مقدار کلید را این‌جا وارد نکنید."
            />
            <Field label="نسخهٔ کلید" name="keyVersion" dir="ltr" defaultValue="v1" />
          </ActionForm>

          <h3>۲. ساخت پیکربندی</h3>
          <ActionForm action={createPaymentConfigurationAction} submitLabel="ساخت پیکربندی">
            <Field label="کد درگاه" name="providerCode" required dir="ltr" placeholder="IDPAY" />
            <Field
              label="شناسهٔ ارجاع کلید"
              name="credentialReferenceId"
              required
              dir="ltr"
              hint="شناسه‌ای که در مرحلهٔ قبل برگردانده شد."
            />
            <Field
              label="شناسهٔ پذیرنده"
              name="merchantReference"
              required
              dir="ltr"
              hint="کد پذیرندهٔ شما نزد درگاه."
            />
            <Field label="نسخهٔ آداپتور" name="adapterVersion" dir="ltr" defaultValue="1.0.0" />
            <SelectField
              label="محیط"
              name="environment"
              options={ENVIRONMENTS}
              defaultValue="TEST"
            />
            <Field label="دلیل" name="reason" required hint="در تاریخچهٔ ممیزی ثبت می‌شود." />
          </ActionForm>
        </details>
      </section>

      <section>
        <h2>سرویس‌های پیامک</h2>
        {sms.ok ? (
          <SmsTable configurations={sms.data} />
        ) : (
          <p className="error-box">{readFailureMessage(sms.error.code)}</p>
        )}

        <details className="card">
          <summary>افزودن سرویس پیامک</summary>
          <p className="muted">
            این پیکربندی پس از ثبت تغییرناپذیر است؛ برای خارج کردن از چرخه، سلامت آن را «ناسالم»
            کنید.
          </p>
          <ActionForm action={createSmsConfigurationAction} submitLabel="ثبت سرویس پیامک">
            <Field label="کد سرویس" name="providerCode" required dir="ltr" placeholder="LIMOOSMS" />
            <Field
              label="ارجاع کلید"
              name="credentialReference"
              required
              dir="ltr"
              placeholder="env://AUTH_SMS_LIMOOSMS_API_KEY"
              hint="ارجاع env:// باید با AUTH_SMS_ شروع شود."
            />
            <Field label="شمارهٔ فرستنده" name="senderReference" required dir="ltr" />
            <Field label="شناسهٔ الگوی پیام" name="templateReference" required dir="ltr" />
            <Field label="نسخهٔ آداپتور" name="adapterVersion" dir="ltr" defaultValue="1.0.0" />
            <SelectField
              label="محیط"
              name="environment"
              options={ENVIRONMENTS}
              defaultValue="TEST"
            />
            <SelectField
              label="فعال"
              name="enabled"
              options={[
                { value: 'true', label: 'بله' },
                { value: 'false', label: 'خیر' },
              ]}
              defaultValue="true"
            />
            <SelectField
              label="پیش‌فرض"
              name="isDefault"
              options={[
                { value: 'true', label: 'بله' },
                { value: 'false', label: 'خیر' },
              ]}
              defaultValue="true"
              hint="در هر محیط فقط یک سرویس فعالِ پیش‌فرض مجاز است."
            />
            <Field
              label="اولویت"
              name="priority"
              dir="ltr"
              inputMode="numeric"
              hint="عدد بین ۱ تا ۱۰۰۰. خالی بگذارید تا مقدار پیش‌فرض اعمال شود."
            />
            <Field label="دلیل" name="reason" required />
          </ActionForm>
        </details>
      </section>
      <section>
        <h2>سرویس ایمیل</h2>
        <p className="muted">
          ایمیل در الو نون برای مشتری نیست — مشتری با پیامک کار می‌کند. این‌جا برای <em>شماست</em>:
          وقتی نیمه‌شب درگاه پرداخت از کار می‌افتد، پیامی ارسال‌نشده می‌ماند، یا پشتیبان‌گیری شکست
          می‌خورد، امروز فقط در لاگ سرور نوشته می‌شود و کسی نمی‌بیندش. تا وقتی این‌جا سرویسی سالم
          ثبت نشده باشد، هیچ هشداری فرستاده نمی‌شود.
        </p>
        {email.ok ? (
          <EmailTable configurations={email.data} />
        ) : (
          <p className="error-box">{readFailureMessage(email.error.code)}</p>
        )}

        {email.ok && (
          <details className="card">
            <summary>افزودن سرویس ایمیل</summary>
            <p className="muted">
              مثل بقیه، این پیکربندی پس از ثبت تغییرناپذیر است؛ برای کنار گذاشتنش سلامتش را «ناسالم»
              کنید.
            </p>
            <ActionForm action={createEmailConfigurationAction} submitLabel="ثبت سرویس ایمیل">
              <Field label="کد سرویس" name="providerCode" required dir="ltr" placeholder="SMTP" />
              <Field
                label="ارجاع رمز"
                name="credentialReference"
                required
                dir="ltr"
                placeholder="env://EMAIL_SMTP_PASSWORD"
                hint="ارجاع env:// باید با EMAIL_ شروع شود. خود رمز را این‌جا وارد نکنید."
              />
              <Field
                label="نشانی فرستنده"
                name="senderAddress"
                required
                dir="ltr"
                placeholder="no-reply@example.com"
                hint="همان نشانی‌ای که گیرنده در «از» می‌بیند."
              />
              <Field
                label="نام فرستنده"
                name="senderName"
                required
                defaultValue="الو نون"
                hint="نامی که کنار نشانی نشان داده می‌شود."
              />
              <Field label="نسخهٔ آداپتور" name="adapterVersion" dir="ltr" defaultValue="1.0.0" />
              <SelectField
                label="محیط"
                name="environment"
                options={ENVIRONMENTS}
                defaultValue="TEST"
              />
              <SelectField
                label="فعال"
                name="enabled"
                options={[
                  { value: 'true', label: 'بله' },
                  { value: 'false', label: 'خیر' },
                ]}
                defaultValue="true"
              />
              <SelectField
                label="پیش‌فرض"
                name="isDefault"
                options={[
                  { value: 'true', label: 'بله' },
                  { value: 'false', label: 'خیر' },
                ]}
                defaultValue="true"
                hint="در هر محیط فقط یک سرویس ایمیل پیش‌فرض مجاز است."
              />
              <Field
                label="اولویت"
                name="priority"
                dir="ltr"
                inputMode="numeric"
                hint="عدد بین ۱ تا ۱۰۰۰. خالی بگذارید تا مقدار پیش‌فرض اعمال شود."
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </details>
        )}
      </section>

      <section>
        <h2>موتور مسیریابی</h2>
        <p className="muted">
          این همان چیزی است که نشانی مشتری را به «چند کیلومتر» تبدیل می‌کند، و کرایهٔ تحویل روی همان
          عدد حساب می‌شود. تا وقتی هیچ مسیریاب سالمی ثبت نشده باشد، سیستم به فاصلهٔ مستقیم روی نقشه
          برمی‌گردد — کار می‌کند، ولی برای شهری با رودخانه و خیابان یک‌طرفه کم‌برآورد می‌کند.
        </p>
        {routing.ok ? (
          <RoutingTable configurations={routing.data} />
        ) : (
          <p className="error-box">{readFailureMessage(routing.error.code)}</p>
        )}

        {routing.ok && (
          <details className="card">
            <summary>افزودن مسیریاب</summary>
            <p className="muted">
              مثل سرویس پیامک، این پیکربندی پس از ثبت تغییرناپذیر است؛ برای کنار گذاشتنش سلامتش را
              «ناسالم» کنید.
            </p>
            <ActionForm action={createRoutingConfigurationAction} submitLabel="ثبت مسیریاب">
              <Field
                label="کد مسیریاب"
                name="providerCode"
                required
                dir="ltr"
                placeholder="NESHAN"
              />
              <Field
                label="ارجاع کلید"
                name="credentialReference"
                required
                dir="ltr"
                placeholder="env://ROUTING_NESHAN_KEY"
                hint="ارجاع env:// باید با ROUTING_ شروع شود. مقدار کلید را این‌جا وارد نکنید."
              />
              <Field label="نسخهٔ آداپتور" name="adapterVersion" dir="ltr" defaultValue="1.0.0" />
              <SelectField
                label="محیط"
                name="environment"
                options={ENVIRONMENTS}
                defaultValue="TEST"
              />
              <SelectField
                label="فعال"
                name="enabled"
                options={[
                  { value: 'true', label: 'بله' },
                  { value: 'false', label: 'خیر' },
                ]}
                defaultValue="true"
              />
              <SelectField
                label="پیش‌فرض"
                name="isDefault"
                options={[
                  { value: 'true', label: 'بله' },
                  { value: 'false', label: 'خیر' },
                ]}
                defaultValue="true"
                hint="در هر محیط فقط یک مسیریاب پیش‌فرض مجاز است."
              />
              <Field
                label="اولویت"
                name="priority"
                dir="ltr"
                inputMode="numeric"
                hint="عدد بین ۱ تا ۱۰۰۰. خالی بگذارید تا مقدار پیش‌فرض اعمال شود."
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </details>
        )}
      </section>
    </main>
  )
}

function PaymentTable({
  configurations,
}: Readonly<{ configurations: PaymentConfigurationSummary[] }>) {
  if (configurations.length === 0) {
    return <p className="muted">هیچ درگاهی پیکربندی نشده است.</p>
  }
  return (
    <div className="rows">
      {configurations.map((configuration) => (
        <article key={configuration.id} className="row">
          <div className="row-head">
            <strong dir="ltr">{configuration.providerCode}</strong>
            <span className="badge">{configuration.environment}</span>
            <span className={`badge health-${configuration.healthStatus.toLowerCase()}`}>
              {HEALTH_LABELS[configuration.healthStatus] ?? configuration.healthStatus}
            </span>
            {configuration.isActive && <span className="badge on">فعال</span>}
            {configuration.isDefault && <span className="badge on">پیش‌فرض</span>}
          </div>
          <dl className="row-meta">
            <div>
              <dt>شناسه</dt>
              <dd dir="ltr">{configuration.id}</dd>
            </div>
            <div>
              <dt>پذیرنده</dt>
              <dd dir="ltr">{configuration.merchantReference}</dd>
            </div>
            <div>
              <dt>نسخهٔ آداپتور</dt>
              <dd dir="ltr">{configuration.adapterVersion}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <ActionForm
              action={governPaymentConfigurationAction}
              submitLabel={configuration.isActive ? 'غیرفعال کن' : 'فعال و پیش‌فرض کن'}
            >
              <input type="hidden" name="configurationId" value={configuration.id} />
              <input
                type="hidden"
                name="governanceVersion"
                value={String(configuration.governanceVersion)}
              />
              <input type="hidden" name="targetActive" value={String(!configuration.isActive)} />
              <input type="hidden" name="makeDefault" value={String(!configuration.isActive)} />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
            <ActionForm action={setPaymentHealthAction} submitLabel="ثبت سلامت">
              <input type="hidden" name="configurationId" value={configuration.id} />
              <SelectField
                label="وضعیت سلامت"
                name="healthStatus"
                options={Object.entries(HEALTH_LABELS).map(([value, label]) => ({ value, label }))}
                defaultValue={configuration.healthStatus}
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </div>
        </article>
      ))}
    </div>
  )
}

function SmsTable({ configurations }: Readonly<{ configurations: SmsConfigurationSummary[] }>) {
  if (configurations.length === 0) {
    return <p className="muted">هیچ سرویس پیامکی پیکربندی نشده است؛ ارسال کد ورود کار نمی‌کند.</p>
  }
  return (
    <div className="rows">
      {configurations.map((configuration) => (
        <article key={configuration.id} className="row">
          <div className="row-head">
            <strong dir="ltr">{configuration.providerCode}</strong>
            <span className="badge">{configuration.environment}</span>
            <span className={`badge health-${configuration.healthStatus.toLowerCase()}`}>
              {HEALTH_LABELS[configuration.healthStatus] ?? configuration.healthStatus}
            </span>
            {configuration.enabled && <span className="badge on">فعال</span>}
            {configuration.isDefault && <span className="badge on">پیش‌فرض</span>}
          </div>
          <dl className="row-meta">
            <div>
              <dt>شناسه</dt>
              <dd dir="ltr">{configuration.id}</dd>
            </div>
            <div>
              <dt>فرستنده</dt>
              <dd dir="ltr">{configuration.senderReference}</dd>
            </div>
            <div>
              <dt>اولویت</dt>
              <dd dir="ltr">{configuration.priority}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <ActionForm action={setSmsHealthAction} submitLabel="ثبت سلامت">
              <input type="hidden" name="configurationId" value={configuration.id} />
              <SelectField
                label="وضعیت سلامت"
                name="healthStatus"
                // UNKNOWN is absent by design: nothing may claim a provider was
                // never observed once it has been.
                options={[
                  { value: 'HEALTHY', label: 'سالم' },
                  { value: 'DEGRADED', label: 'کاهش‌یافته' },
                  { value: 'UNHEALTHY', label: 'ناسالم' },
                ]}
                defaultValue={configuration.healthStatus === 'HEALTHY' ? 'UNHEALTHY' : 'HEALTHY'}
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </div>
        </article>
      ))}
    </div>
  )
}

/**
 * What each routing engine is, and the one control an operator has over it.
 *
 * The credential reference is shown on purpose. It is not the key — the key
 * never leaves the deployment's environment — but "which variable is this
 * reading?" is the first question when distances come back wrong, and making
 * the operator guess it wastes the hour that matters.
 */
function RoutingTable({
  configurations,
}: Readonly<{ configurations: RoutingConfigurationSummary[] }>) {
  if (configurations.length === 0) {
    return (
      <p className="muted">
        هیچ مسیریابی ثبت نشده است؛ کرایهٔ تحویل روی فاصلهٔ مستقیم حساب می‌شود.
      </p>
    )
  }
  return (
    <div className="rows">
      {configurations.map((configuration) => (
        <article key={configuration.id} className="row">
          <div className="row-head">
            <strong dir="ltr">{configuration.providerCode}</strong>
            <span className="badge">{configuration.environment}</span>
            <span className={`badge health-${configuration.healthStatus.toLowerCase()}`}>
              {HEALTH_LABELS[configuration.healthStatus] ?? configuration.healthStatus}
            </span>
            {configuration.enabled && <span className="badge on">فعال</span>}
            {configuration.isDefault && <span className="badge on">پیش‌فرض</span>}
          </div>
          <dl className="row-meta">
            <div>
              <dt>شناسه</dt>
              <dd dir="ltr">{configuration.id}</dd>
            </div>
            <div>
              <dt>ارجاع کلید</dt>
              <dd dir="ltr">{configuration.credentialReference}</dd>
            </div>
            <div>
              <dt>اولویت</dt>
              <dd dir="ltr">{configuration.priority}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <ActionForm action={setRoutingHealthAction} submitLabel="ثبت سلامت">
              <input type="hidden" name="configurationId" value={configuration.id} />
              <SelectField
                label="وضعیت سلامت"
                name="healthStatus"
                // UNKNOWN is absent by design: nothing may claim an engine was
                // never observed once it has been.
                options={[
                  { value: 'HEALTHY', label: 'سالم' },
                  { value: 'DEGRADED', label: 'کاهش‌یافته' },
                  { value: 'UNHEALTHY', label: 'ناسالم' },
                ]}
                defaultValue={configuration.healthStatus === 'HEALTHY' ? 'UNHEALTHY' : 'HEALTHY'}
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </div>
        </article>
      ))}
    </div>
  )
}

/**
 * Each email service, and the one control an operator has over it.
 *
 * The sender address and name are shown because they are the two things a
 * recipient actually sees, and "why does our mail look like it is from nobody"
 * is answered here rather than by reading a database.
 */
function EmailTable({ configurations }: Readonly<{ configurations: EmailConfigurationSummary[] }>) {
  if (configurations.length === 0) {
    return <p className="muted">هیچ سرویس ایمیلی ثبت نشده است؛ هشدارها فقط در لاگ سرور می‌مانند.</p>
  }
  return (
    <div className="rows">
      {configurations.map((configuration) => (
        <article key={configuration.id} className="row">
          <div className="row-head">
            <strong dir="ltr">{configuration.providerCode}</strong>
            <span className="badge">{configuration.environment}</span>
            <span className={`badge health-${configuration.healthStatus.toLowerCase()}`}>
              {HEALTH_LABELS[configuration.healthStatus] ?? configuration.healthStatus}
            </span>
            {configuration.enabled && <span className="badge on">فعال</span>}
            {configuration.isDefault && <span className="badge on">پیش‌فرض</span>}
          </div>
          <dl className="row-meta">
            <div>
              <dt>فرستنده</dt>
              <dd dir="ltr">
                {configuration.senderName} &lt;{configuration.senderAddress}&gt;
              </dd>
            </div>
            <div>
              <dt>ارجاع رمز</dt>
              <dd dir="ltr">{configuration.credentialReference}</dd>
            </div>
            <div>
              <dt>شناسه</dt>
              <dd dir="ltr">{configuration.id}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <ActionForm action={setEmailHealthAction} submitLabel="ثبت سلامت">
              <input type="hidden" name="configurationId" value={configuration.id} />
              <SelectField
                label="وضعیت سلامت"
                name="healthStatus"
                // UNKNOWN is absent by design: nothing may claim a service was
                // never observed once it has been.
                options={[
                  { value: 'HEALTHY', label: 'سالم' },
                  { value: 'DEGRADED', label: 'کاهش‌یافته' },
                  { value: 'UNHEALTHY', label: 'ناسالم' },
                ]}
                defaultValue={configuration.healthStatus === 'HEALTHY' ? 'UNHEALTHY' : 'HEALTHY'}
              />
              <Field label="دلیل" name="reason" required />
            </ActionForm>
          </div>
        </article>
      ))}
    </div>
  )
}
