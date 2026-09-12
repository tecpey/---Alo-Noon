import { redirect } from 'next/navigation'

import { grantRoleAction, revokeRoleAction } from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listAccessRoles,
  listGrantableBranches,
  listStaff,
  type AdminRoleSummary,
  type GrantableBranch,
  type StaffMember,
} from '../../../lib/admin-api'
import { branchHint, formatDateTime } from '../../../lib/admin-format-display'
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
  ORDER_OPERATOR: 'صف سفارش‌های کل مجموعه: پذیرش، تولید و تحویل.',
  FINANCE_ADMIN: 'تسویه با شرکا، پرداخت به آن‌ها و برداشت مشتری‌ها.',
  BRANCH_OPERATOR: 'پشت پیشخوانِ یک شعبه: صف همان شعبه و بس.',
  BRANCH_OWNER: 'همان بالا، به‌علاوهٔ درآمد و مانده‌ی همان شعبه.',
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'payment-provider.configuration.govern': 'درگاه پرداخت',
  'auth-delivery-provider.configuration.govern': 'سرویس پیامک ورود',
  'notification-provider.configuration.govern': 'سرویس اعلان',
  'admin.reports.read': 'گزارش‌ها',
  'admin.orders.read': 'سفارش‌ها',
  'admin.catalog.manage': 'کاتالوگ و قیمت',
  'admin.access.manage': 'مدیریت دسترسی',
  'admin.orders.manage': 'پیشبرد سفارش‌ها',
  'admin.finance.settle': 'تسویه و پرداخت',
  'routing-provider.configuration.govern': 'سرویس مسیریاب',
}

export default async function AdminAccessPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const rawSearch = params['branch']
  const branchSearch = (Array.isArray(rawSearch) ? rawSearch[0] : rawSearch)?.trim() ?? ''

  const [staff, roles, branches] = await Promise.all([
    listStaff(),
    listAccessRoles(),
    listGrantableBranches(branchSearch),
  ])
  if (
    (!staff.ok && isUnauthenticated(staff.error)) ||
    (!roles.ok && isUnauthenticated(roles.error))
  )
    redirect('/admin/login')

  const roleList: AdminRoleSummary[] = roles.ok ? roles.data : []
  const grantable = roleList.filter((role) => role.grantable)
  // Two forms, because they are two acts. A tenant role is granted once and
  // sees everything; a branch role is granted against one counter. One form
  // with an optional branch field would let somebody hand a bakery's clerk the
  // whole city by leaving a select alone.
  const tenantRoles = grantable.filter((role) => role.scope === 'TENANT')
  const branchRoles = grantable.filter((role) => role.scope === 'BAKERY_BRANCH')
  const branchList: GrantableBranch[] = branches.ok ? branches.data.branches : []
  const branchTotal = branches.ok ? branches.data.totalItems : 0
  // More matched than came back, so the list on screen is a page rather than
  // the answer and the operator needs to narrow it.
  const branchesTruncated = branchTotal > branchList.length

  return (
    <main className="admin">
      <AdminNav
        active="/admin/access"
        title="دسترسی‌ها"
        subtitle="چه کسی این مجموعه را اداره می‌کند، و با چه اختیاری"
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
              options={tenantRoles.map((role) => ({
                value: role.code,
                label: `${role.name} — ${ROLE_DESCRIPTIONS[role.code] ?? role.code}`,
              }))}
              {...(tenantRoles.length === 0 && {
                hint: 'حساب شما هیچ نقشی را کامل پوشش نمی‌دهد، پس چیزی برای دادن ندارید.',
              })}
            />
            <Field label="دلیل" name="reason" required placeholder="مسئول کاتالوگ شعبهٔ مرکزی" />
          </ActionForm>
        </details>

        <details className="card">
          <summary>اعطای دسترسی شعبه به کارکنان نانوایی</summary>
          <p className="muted">
            این نقش‌ها به <strong>یک شعبه</strong> بسته‌اند و بیرون از آن هیچ چیز نمی‌بینند. کارکنان
            نانوایی از <code dir="ltr">/bakery</code> وارد می‌شوند، نه از پنل مدیریت. آن‌ها هم باید
            یک بار با همان شماره وارد شده باشند.
          </p>
          {/*
            Narrowing lives outside the grant form, because a form cannot nest
            inside another and because these are two acts: finding the branch,
            then granting against it. A plain GET reloads the page with a
            shorter list, so it works with no JavaScript at all — which on a
            panel somebody opens on a phone in a bakery is not a small thing.
          */}
          {(branchesTruncated || branchSearch) && (
            <form className="branch-search" method="get">
              <label htmlFor="branch-search">جست‌وجوی شعبه</label>
              <div className="branch-search__row">
                <input
                  id="branch-search"
                  name="branch"
                  type="search"
                  defaultValue={branchSearch}
                  placeholder="نام شعبه یا نانوایی"
                  autoComplete="off"
                  enterKeyHint="search"
                />
                <button type="submit">جست‌وجو</button>
              </div>
            </form>
          )}
          <ActionForm action={grantRoleAction} submitLabel="اعطای دسترسی شعبه">
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
              options={branchRoles.map((role) => ({
                value: role.code,
                label: `${role.name} — ${ROLE_DESCRIPTIONS[role.code] ?? role.code}`,
              }))}
              {...(branchRoles.length === 0 && {
                hint: 'حساب شما این نقش‌ها را کامل پوشش نمی‌دهد، پس چیزی برای دادن ندارید.',
              })}
            />
            <SelectField
              label="شعبه"
              name="bakeryBranchId"
              options={branchList.map((branch) => ({
                value: branch.id,
                label: `${branch.nameFa} — ${branch.bakeryNameFa}`,
              }))}
              hint={branchHint(branchList.length, branchTotal, branchSearch)}
            />
            <Field label="دلیل" name="reason" required placeholder="صاحب نانوایی، شعبهٔ مرکزی" />
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
                  <th>دامنه</th>
                  <th>برای چه کسی</th>
                  <th>اختیارات</th>
                  <th>شما می‌توانید بدهید؟</th>
                </tr>
              </thead>
              <tbody>
                {roleList.map((role) => (
                  <tr key={role.code}>
                    <td>{role.name}</td>
                    <td>{role.scope === 'BAKERY_BRANCH' ? 'یک شعبه' : 'کل مجموعه'}</td>
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

/**
 * A role with the branch it reaches, when it reaches only one.
 *
 * The branch is never omitted. A review that lists «اپراتور شعبه» without
 * saying which shop is a review that cannot answer the question it exists to
 * answer.
 */
function roleLabel(role: StaffMember['roles'][number]): string {
  return role.bakeryBranchNameFa ? `${role.name} (${role.bakeryBranchNameFa})` : role.name
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
            <dd>{member.roles.map(roleLabel).join('، ')}</dd>
          </div>
          <div>
            <dt>اختیارات در کل مجموعه</dt>
            <dd>
              {member.permissions.length === 0
                ? // Every grant this account holds is branch-scoped. Saying so
                  // is the point: an empty list here would read as "no access".
                  'ندارد — دسترسی‌اش فقط روی شعبه است.'
                : member.permissions
                    .map((permission) => PERMISSION_LABELS[permission] ?? permission)
                    .join('، ')}
            </dd>
          </div>
        </dl>
      )}

      {member.roles.map((role) => (
        <div className="row-actions" key={role.grantId}>
          <span className="muted">
            {roleLabel(role)} — از {formatDateTime(role.grantedAt)}
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
