import { redirect } from 'next/navigation'

import { grantRoleAction, revokeRoleAction } from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listAccessRoles,
  listStaff,
  type AdminRoleSummary,
  type StaffMember,
} from '../../../lib/admin-api'
import { formatDateTime } from '../../../lib/admin-format-display'
import { ActionForm, Field, SelectField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

/**
 * What each role is for, in the words an operator would use. The permission
 * codes are shown too, because a role name alone does not tell someone what
 * they are about to hand over.
 */
const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  TENANT_ADMIN: 'همه چیز، شامل دادن و گرفتن دسترسی.',
  PROVIDER_GOVERNOR: 'فقط پیکربندی درگاه پرداخت و سرویس پیامک.',
  OPERATIONS_ANALYST: 'فقط دیدن گزارش‌ها و سفارش‌ها.',
  CATALOG_MANAGER: 'مدیریت کاتالوگ، قیمت‌ها و موجودی.',
  ACCESS_ADMIN: 'فقط دادن و گرفتن دسترسی، بدون هیچ دسترسی عملیاتی دیگر.',
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'payment-provider.configuration.govern': 'درگاه پرداخت',
  'auth-delivery-provider.configuration.govern': 'سرویس پیامک ورود',
  'notification-provider.configuration.govern': 'سرویس اعلان',
  'admin.reports.read': 'گزارش‌ها',
  'admin.orders.read': 'سفارش‌ها',
  'admin.catalog.manage': 'کاتالوگ و قیمت',
  'admin.access.manage': 'مدیریت دسترسی',
}

export default async function AdminAccessPage() {
  const [staff, roles] = await Promise.all([listStaff(), listAccessRoles()])
  if (
    (!staff.ok && isUnauthenticated(staff.error)) ||
    (!roles.ok && isUnauthenticated(roles.error))
  )
    redirect('/admin/login')

  const roleList: AdminRoleSummary[] = roles.ok ? roles.data : []
  const grantable = roleList.filter((role) => role.grantable)

  return (
    <main className="admin">
      <AdminNav
        active="/admin/access"
        title="دسترسی‌ها"
        subtitle="چه کسی این tenant را اداره می‌کند، و با چه اختیاری"
      />

      <aside className="note">
        شما فقط می‌توانید نقشی را بدهید که <em>خودتان همهٔ دسترسی‌هایش را دارید</em>. این عمدی است:
        بدون آن، کسی که تنها اختیارش مدیریت دسترسی است می‌توانست خودش را مدیر کل کند. به همین دلیل
        هم حساب نمی‌تواند دسترسی خودش را لغو کند — برای بازگرداندنش باید به خط فرمان سرور دسترسی
        داشته باشید.
      </aside>

      <section>
        <h2>اپراتورها</h2>
        {staff.ok ? (
          staff.data.length === 0 ? (
            <p className="muted">هنوز هیچ حسابی نقش مدیریتی ندارد.</p>
          ) : (
            <ul className="rows">
              {staff.data.map((member) => (
                <StaffRow key={member.accountId} member={member} />
              ))}
            </ul>
          )
        ) : (
          <p className="error-box">{readFailureMessage(staff.error.code)}</p>
        )}
      </section>

      <section>
        <h2>دادن دسترسی</h2>
        <details className="card">
          <summary>اعطای نقش به یک شماره</summary>
          <p className="muted">
            آن شخص باید <strong>یک بار با همان شماره وارد شده باشد</strong>. ورود است که حسابش را
            می‌سازد و ثابت می‌کند شماره در اختیار خودش است؛ تا آن نشده باشد، این فرم خطا می‌دهد.
          </p>
          <ActionForm action={grantRoleAction} submitLabel="اعطای نقش">
            <Field
              label="شمارهٔ موبایل"
              name="mobileE164"
              required
              dir="ltr"
              inputMode="tel"
              placeholder="09121234567"
            />
            <SelectField
              label="نقش"
              name="roleCode"
              options={grantable.map((role) => ({
                value: role.code,
                label: `${role.name} — ${ROLE_DESCRIPTIONS[role.code] ?? role.code}`,
              }))}
              {...(grantable.length === 0 && {
                hint: 'حساب شما هیچ نقشی را کامل پوشش نمی‌دهد، پس چیزی برای دادن ندارید.',
              })}
            />
            <Field label="دلیل" name="reason" required placeholder="مسئول کاتالوگ شعبهٔ مرکزی" />
          </ActionForm>
        </details>
      </section>

      <section>
        <h2>نقش‌ها و اختیاراتشان</h2>
        {roles.ok ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>نقش</th>
                  <th>برای چه کسی</th>
                  <th>اختیارات</th>
                  <th>شما می‌توانید بدهید؟</th>
                </tr>
              </thead>
              <tbody>
                {roleList.map((role) => (
                  <tr key={role.code}>
                    <td>{role.name}</td>
                    <td>{ROLE_DESCRIPTIONS[role.code] ?? '—'}</td>
                    <td>
                      {role.permissions
                        .map((permission) => PERMISSION_LABELS[permission] ?? permission)
                        .join('، ')}
                    </td>
                    <td>{role.grantable ? 'بله' : 'خیر — فراتر از دسترسی شماست'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="error-box">{readFailureMessage(roles.error.code)}</p>
        )}
      </section>
    </main>
  )
}

function StaffRow({ member }: Readonly<{ member: StaffMember }>) {
  return (
    <li className="row">
      <div className="row-head">
        <strong dir="ltr">{member.mobileE164}</strong>
        {member.isSelf && <span className="badge">خودتان</span>}
        {member.status !== 'ACTIVE' && <span className="badge">حساب غیرفعال</span>}
      </div>

      {member.roles.length === 0 ? (
        <p className="muted">هیچ نقش فعالی ندارد.</p>
      ) : (
        <dl className="row-meta">
          <div>
            <dt>نقش‌ها</dt>
            <dd>{member.roles.map((role) => role.name).join('، ')}</dd>
          </div>
          <div>
            <dt>اختیارات</dt>
            <dd>
              {member.permissions
                .map((permission) => PERMISSION_LABELS[permission] ?? permission)
                .join('، ')}
            </dd>
          </div>
        </dl>
      )}

      {member.roles.map((role) => (
        <div className="row-actions" key={role.grantId}>
          <span className="muted">
            {role.name} — از {formatDateTime(role.grantedAt)}
          </span>
          {member.isSelf ? (
            // Shown rather than hidden: an operator who wonders why they cannot
            // remove their own role deserves the reason on the page, not a
            // refusal after the click.
            <span className="muted">دسترسی خودتان از این‌جا قابل لغو نیست.</span>
          ) : (
            <ActionForm action={revokeRoleAction} submitLabel="لغو نقش">
              <input type="hidden" name="grantId" value={role.grantId} />
              <Field label="دلیل" name="reason" required placeholder="پایان همکاری" />
            </ActionForm>
          )}
        </div>
      ))}
    </li>
  )
}
