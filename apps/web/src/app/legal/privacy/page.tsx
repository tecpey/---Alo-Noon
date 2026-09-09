import Link from 'next/link'
import type { Metadata } from 'next'

import { LegalContact } from '../legal-contact'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'حریم خصوصی | الو نون',
  description: 'چه اطلاعاتی نگه می‌داریم، چرا، چه مدت، و با چه کسی در میان می‌گذاریم.',
}

/**
 * The privacy notice.
 *
 * Each claim is checkable against the code, and several of them exist because
 * the code took a specific decision worth telling people about: card numbers
 * are truncated to four digits before a row is written, one-time codes are
 * stored as peppered digests, and consent for engagement messages is separate
 * from the transactional ones an order needs.
 *
 * The section on what is *not* collected matters as much as the rest. A notice
 * that only lists what a company takes reads as a company that takes
 * everything.
 */
export default function PrivacyPage() {
  return (
    <article className="legal__article">
      <h1>حریم خصوصی</h1>
      <p className="legal__updated">آخرین بازنگری: شهریور ۱۴۰۵</p>

      <section>
        <h2>اصل کار</h2>
        <p>
          چیزی را جمع نمی‌کنیم که برای رساندن نان به شما لازم نباشد. هر مورد در این صفحه یک دلیل
          عملی دارد؛ اگر دلیلی نداشته باشد، اصلاً ذخیره نمی‌شود.
        </p>
      </section>

      <section>
        <h2>چه چیزی نگه می‌داریم</h2>
        <ul>
          <li>
            <strong>شمارهٔ موبایل.</strong> تنها راه ورود شما و تنها راه تماس پیک با شماست.
          </li>
          <li>
            <strong>نام و نشانی گیرنده.</strong> بدون آن‌ها سفارش به جایی نمی‌رسد. نشانی روی خودِ
            سفارش «عکس‌برداری» می‌شود تا بعداً تغییر دفترچهٔ نشانی‌ها، سابقهٔ تحویل را عوض نکند.
          </li>
          <li>
            <strong>موقعیت مکانی نشانی.</strong> برای تشخیص اینکه در محدودهٔ سرویس هستید و برای
            مسیریابی پیک.
          </li>
          <li>
            <strong>سفارش‌ها و پرداخت‌ها.</strong> برای پشتیبانی، بازگشت وجه، و تکالیف مالیاتی و
            حسابداری.
          </li>
          <li>
            <strong>گردش کیف پول.</strong> ثبت دائمی دارد و پاک یا ویرایش نمی‌شود؛ همین است که به
            سؤال «پول من کجا رفت» جواب می‌دهد.
          </li>
        </ul>
      </section>

      <section>
        <h2>چه چیزی را نگه نمی‌داریم</h2>
        <ul>
          <li>
            <strong>شمارهٔ کامل کارت بانکی.</strong> هنگام درخواست برداشت، شمارهٔ کارت یک بار
            فرستاده می‌شود و <strong>فقط چهار رقم آخر</strong> ذخیره می‌شود. بقیه‌اش پیش از نوشتن در
            پایگاه داده دور ریخته می‌شود و در هیچ گزارش یا لاگی نیست.
          </li>
          <li>
            <strong>اطلاعات کارت هنگام خرید.</strong> پرداخت روی صفحهٔ خودِ بانک انجام می‌شود؛ ما
            فقط نتیجه را می‌گیریم.
          </li>
          <li>
            <strong>رمز عبور.</strong> اصلاً وجود ندارد. کد یک‌بارمصرف هم به‌صورت خام ذخیره نمی‌شود
            — فقط اثری از آن می‌ماند که فقط برای تأیید همان کد به کار می‌آید.
          </li>
        </ul>
      </section>

      <section>
        <h2>با چه کسی در میان گذاشته می‌شود</h2>
        <ul>
          <li>
            <strong>نانوایی</strong>: نام گیرنده و اقلام سفارش. نانوایی نشانی کامل شما را نمی‌بیند.
          </li>
          <li>
            <strong>پیک</strong>: نام، نشانی و شمارهٔ تماس گیرنده — تا زمانی که سفارش تحویل شود.
          </li>
          <li>
            <strong>درگاه بانکی</strong>: مبلغ و شناسهٔ سفارش، نه اطلاعات شخصی شما.
          </li>
          <li>
            <strong>سرویس پیامک</strong>: شمارهٔ موبایل و متن پیام.
          </li>
        </ul>
        <p>
          اطلاعات شما را به کسی نمی‌فروشیم و برای تبلیغات در اختیار دیگری نمی‌گذاریم. تنها استثنا
          درخواست مراجع قانونی است، در همان حدی که قانون تعیین می‌کند.
        </p>
      </section>

      <section>
        <h2>پیامک‌ها</h2>
        <p>
          پیامک‌های مربوط به سفارش — تأیید، آماده‌شدن، تحویل — بخشی از خودِ سرویس‌اند و قابل
          غیرفعال‌کردن نیستند؛ بدون آن‌ها نمی‌دانید نانتان کجاست. پیامک‌های تبلیغاتی و نظرسنجی
          جداگانه‌اند و <strong>فقط با رضایت شما</strong> فرستاده می‌شوند. رضایت را هر وقت بخواهید
          پس بگیرید.
        </p>
      </section>

      <section>
        <h2>چه مدت</h2>
        <ul>
          <li>سابقهٔ سفارش و پرداخت: تا زمانی که قانون تجارت و مالیات ایجاب می‌کند.</li>
          <li>نشست‌های ورود: تا انقضا یا خروج شما.</li>
          <li>کد یک‌بارمصرف: چند دقیقه. پس از آن حتی اثرش هم به کار نمی‌آید.</li>
        </ul>
      </section>

      <section>
        <h2>حق شما</h2>
        <p>
          می‌توانید بخواهید اطلاعاتتان را به شما نشان دهیم، اصلاح کنیم، یا حسابتان را ببندیم. بستن
          حساب، سابقهٔ مالی سفارش‌های انجام‌شده را پاک نمی‌کند — نگه‌داشتن آن تکلیف قانونی است — ولی
          موجودی کیف پولتان به کارتتان برگردانده می‌شود. جزئیات در{' '}
          <Link href="/legal/refunds">شرایط بازگشت وجه</Link>.
        </p>
      </section>

      <section>
        <h2>تماس</h2>
        <LegalContact />
      </section>
    </article>
  )
}
