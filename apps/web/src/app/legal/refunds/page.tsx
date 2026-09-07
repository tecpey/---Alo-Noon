import Link from 'next/link'
import type { Metadata } from 'next'

import { formatToman } from '../../../lib/persian'
import { MINIMUM_WITHDRAWAL } from '@alo-noon/domain'
import { LegalContact } from '../legal-contact'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'شرایط بازگشت وجه | الو نون',
  description: 'چه زمانی پول برمی‌گردد، کجا برمی‌گردد، و چطور می‌توانید آن را به کارت خود بگیرید.',
}

/**
 * The refund policy.
 *
 * Every sentence here describes something the code actually does, and that is
 * not a style choice — this is the page a customer quotes back when they are
 * angry and a regulator reads when they are checking. A policy that promises a
 * path the software refuses is worse than no policy, because it converts a
 * technical gap into a broken promise.
 *
 * Specifically: a refund credits the wallet, and the wallet has a way out to a
 * bank card. Until that way out existed this page could not have said the
 * second half, and saying it anyway would have been the lie.
 */
export default function RefundPolicyPage() {
  return (
    <article className="legal__article">
      <h1>شرایط بازگشت وجه</h1>
      <p className="legal__updated">آخرین بازنگری: شهریور ۱۴۰۵</p>

      <section>
        <h2>خلاصه در سه خط</h2>
        <ul>
          <li>
            سفارشی که لغو یا رد شود، تمام مبلغش <strong>همان لحظه</strong> به کیف پول شما برمی‌گردد.
          </li>
          <li>موجودی کیف پول را می‌توانید خرج کنید، به کیف پول دیگری بفرستید، یا پس بگیرید.</li>
          <li>
            پس‌گرفتن به کارت بانکیِ خودتان انجام می‌شود و معمولاً یک تا سه روز کاری طول می‌کشد.
          </li>
        </ul>
      </section>

      <section>
        <h2>پول کِی برمی‌گردد</h2>
        <p>
          پرداخت پیش از تأیید سفارش انجام می‌شود، پس همیشه ممکن است سفارشی پرداخت شده باشد و انجام
          نشود. در این حالت‌ها تمام مبلغ برمی‌گردد:
        </p>
        <ul>
          <li>
            <strong>نانوایی سفارش را نپذیرد یا رد کند.</strong> نانوایی حق دارد سفارشی را که
            نمی‌تواند بپزد رد کند؛ برگشت وجه با پلتفرم است، نه با نانوایی.
          </li>
          <li>
            <strong>سفارش پیش از تحویل لغو شود.</strong> چه شما لغو کنید و چه ما، تا وقتی نان تحویل
            نشده مبلغ کامل برمی‌گردد.
          </li>
          <li>
            <strong>تحویل انجام نشود.</strong> اگر سفارش به دستتان نرسد، مبلغ کامل برمی‌گردد.
          </li>
        </ul>
        <p>
          برگشت وجه دستی نیست و منتظر تأیید کسی نمی‌ماند: در همان تراکنشی که سفارش لغو می‌شود، مبلغ
          به کیف پول شما اضافه می‌شود و در «گردش کیف پول» به‌عنوان یک سطر با عنوان «بازگشت وجه
          سفارش» ثبت می‌شود.
        </p>
      </section>

      <section>
        <h2>چرا اول به کیف پول</h2>
        <p>
          چون فوری است. برگشت به کارت از مسیر درگاه بانکی چند روز طول می‌کشد و در این چند روز پول نه
          دست شماست و نه قابل استفاده. کیف پول همان لحظه شارژ می‌شود و می‌توانید بلافاصله سفارش
          دوباره بدهید.
        </p>
        <p>
          <strong>کیف پول جای پول شماست، نه اعتبار فروشگاهی.</strong> هر زمان بخواهید می‌توانید آن
          را به کارت بانکی‌تان پس بگیرید و ما نمی‌توانیم شرطی برایش بگذاریم.
        </p>
      </section>

      <section>
        <h2>پس‌گرفتن به کارت بانکی</h2>
        <ol>
          <li>
            وارد <Link href="/wallet">کیف پول</Link> شوید و «درخواست برداشت» را بزنید.
          </li>
          <li>
            مبلغ، شمارهٔ کارت ۱۶ رقمی و نام صاحب کارت را وارد کنید. اگر شبا دارید، وارد کردنش کار را
            سریع‌تر می‌کند.
          </li>
          <li>
            مبلغ <strong>همان لحظه</strong> از موجودی کم می‌شود تا اشتباهاً دو بار خرج نشود.
          </li>
          <li>واریز را به‌صورت دستی و در روزهای کاری انجام می‌دهیم؛ معمولاً یک تا سه روز کاری.</li>
        </ol>
        <ul>
          <li>
            کمترین مبلغ برداشت {formatToman(MINIMUM_WITHDRAWAL.toString())} است. سقفی وجود ندارد؛
            می‌توانید همهٔ موجودی‌تان را بخواهید.
          </li>
          <li>
            کارت باید <strong>به نام خودتان</strong> باشد. واریز به کارت شخص دیگر انجام نمی‌شود.
          </li>
          <li>
            اگر درخواست رد شود، مبلغ همان لحظه به کیف پول برمی‌گردد و دلیل رد را در همان صفحهٔ کیف
            پول می‌بینید.
          </li>
          <li>بابت برداشت کارمزدی از شما گرفته نمی‌شود.</li>
        </ul>
      </section>

      <section>
        <h2>چه چیزی برنمی‌گردد</h2>
        <p>
          سفارشی که <strong>تحویل داده شده</strong> به‌خودیِ‌خود مشمول بازگشت وجه نیست. نان کالای
          فسادپذیر است و پس از تحویل قابل بازگشت نیست. ولی اگر کالا مشکل داشت — بسته آسیب دیده بود،
          چیزی کم بود، یا نان تازه نبود — با ما تماس بگیرید. رسیدگی می‌کنیم و اگر حق با شما بود مبلغ
          برمی‌گردد. این را حق شما می‌دانیم، نه لطف.
        </p>
        <p className="legal__note">
          این سیاست حقوق شما را بر اساس قانون حمایت از حقوق مصرف‌کنندگان و قانون تجارت الکترونیکی
          محدود نمی‌کند. هر جا این متن با قانون اختلاف داشته باشد، قانون معتبر است.
        </p>
      </section>

      <section>
        <h2>اگر چیزی درست پیش نرفت</h2>
        <p>
          هر سطر کیف پول شما ثبت دائمی دارد و پاک یا ویرایش نمی‌شود؛ اگر عددی به نظرتان اشتباه است،
          می‌توانیم دقیقاً بگوییم چه اتفاقی افتاده. با ما تماس بگیرید:
        </p>
        <LegalContact />
      </section>
    </article>
  )
}
