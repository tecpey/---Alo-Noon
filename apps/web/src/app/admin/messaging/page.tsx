import { redirect } from 'next/navigation'

import { saveMessageTemplateAction } from '../../../lib/admin-actions'
import {
  isUnauthenticated,
  listMessageTemplates,
  type MessageTemplate,
} from '../../../lib/admin-api'
import { formatDateTime } from '../../../lib/admin-format-display'
import { ActionForm, SelectField, TextAreaField } from '../action-form'
import { AdminNav } from '../admin-nav'
import { readFailureMessage } from '../failure-message'

export const dynamic = 'force-dynamic'

/**
 * The words the system says to customers.
 *
 * Every message appears here whether or not this tenant has customised it, so a
 * message going out in its shipped wording is still visible to whoever has to
 * answer the phone about it. A template nobody has edited shows the default it
 * is sending, not an empty box.
 */
export default async function AdminMessagingPage() {
  const templates = await listMessageTemplates()
  if (!templates.ok && isUnauthenticated(templates.error)) redirect('/admin/login')

  return (
    <main className="admin">
      <AdminNav
        active="/admin/messaging"
        title="متن پیام‌ها"
        subtitle="هر چیزی که سیستم برای مشتری پیامک می‌کند"
      />

      <aside className="note">
        متغیرها با آکولاد نوشته می‌شوند — مثل <code dir="ltr">{'{orderCode}'}</code> — و هنگام ارسال
        با مقدار واقعی جایگزین می‌شوند. فقط متغیرهای همان پیام پذیرفته می‌شوند؛ اگر متغیری بنویسید
        که این پیام آن را ندارد، ذخیره نمی‌شود، چون همان‌طور که نوشته‌اید برای مشتری فرستاده می‌شد.
        <br />
        متن فارسی با کدگذاری UCS-2 ارسال می‌شود: تا ۷۰ کاراکتر یک پیامک، از ۷۱ کاراکتر به بعد هر ۶۷
        کاراکتر یک پیامک. شمارندهٔ زیر هر متن، هزینهٔ واقعی همان پیام است.
      </aside>

      {templates.ok ? (
        <div className="rows">
          {templates.data.map((template) => (
            <TemplateCard key={template.purpose} template={template} />
          ))}
        </div>
      ) : (
        <p className="error-box">{readFailureMessage(templates.error.code)}</p>
      )}
    </main>
  )
}

function TemplateCard({ template }: Readonly<{ template: MessageTemplate }>) {
  // The sign-in message is the one that cannot be switched off: without it
  // nobody can get in, including whoever would have to switch it back on.
  const required = template.purpose === 'AUTH_OTP'

  return (
    <section className="row">
      <div className="row-head">
        <h2>{template.labelFa}</h2>
        {!template.customized && <span className="badge">پیش‌فرض</span>}
        {!template.enabled && <span className="badge">خاموش</span>}
      </div>
      <p className="muted">{template.descriptionFa}</p>

      <dl className="row-meta">
        <div>
          <dt>وضعیت</dt>
          <dd>
            {template.customized
              ? `متن اختصاصی این tenant (نسخهٔ ${template.version})`
              : 'متن پیش‌فرض سیستم'}
          </dd>
        </div>
        <div>
          <dt>ارسال</dt>
          <dd>{template.enabled ? 'فعال' : 'خاموش'}</dd>
        </div>
        <div>
          <dt>هزینه</dt>
          <dd>{template.segments} پیامک</dd>
        </div>
        {template.updatedAt && (
          <div>
            <dt>آخرین تغییر</dt>
            <dd>{formatDateTime(template.updatedAt)}</dd>
          </div>
        )}
      </dl>

      <p className="muted">متغیرهای مجاز این پیام:</p>
      <ul className="chips">
        {template.variables.map((variable) => (
          <li key={variable.name}>
            <code dir="ltr">{`{${variable.name}}`}</code> {variable.labelFa}
            {variable.required && ' — اجباری'}
          </li>
        ))}
      </ul>

      <blockquote className="preview" dir="rtl">
        {template.preview}
      </blockquote>

      <ActionForm action={saveMessageTemplateAction} submitLabel="ذخیرهٔ متن">
        <input type="hidden" name="purpose" value={template.purpose} />
        <TextAreaField
          label="متن پیام"
          name="body"
          rows={3}
          maxLength={480}
          defaultValue={template.body}
          hint={`پیش‌فرض سیستم: ${template.defaultBody}`}
        />
        {required ? (
          <input type="hidden" name="enabled" value="true" />
        ) : (
          <SelectField
            label="ارسال این پیام"
            name="enabled"
            defaultValue={String(template.enabled)}
            options={[
              { value: 'true', label: 'فعال' },
              { value: 'false', label: 'خاموش' },
            ]}
          />
        )}
      </ActionForm>
    </section>
  )
}
