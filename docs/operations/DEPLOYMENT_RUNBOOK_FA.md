# راهنمای استقرار — الو نون

این سند می‌گوید سرویس چطور روی یک سرور واقعی بالا می‌آید، چطور نسخهٔ جدید
می‌رود، چطور پشتیبان گرفته و **بازگردانده** می‌شود، و وقتی چیزی خراب شد چطور عقب
می‌گردیم.

پیکربندی خودِ کسب‌وکار — درگاه پرداخت، پنل پیامک، دسترسی اپراتورها، کاتالوگ —
این‌جا نیست؛ در
[راهنمای راه‌اندازی و مدیریت عملیات](ADMIN_OPERATIONS_GUIDE_FA.md) است. ترتیب
درست این است: **اول این سند تا سرویس بالا بیاید، بعد آن سند تا سرویس کار کند.**

> [!NOTE] **چه چیزی این‌جا آزموده شده و چه چیزی نه.** فرمان‌های ساخت، اجرای
> بسته‌شده با `node` خالی، پشتیبان‌گیری و بازگردانی کامل با
> `pg_dump`/`pg_restore`، و اعتبارسنجی فایل‌های systemd با
> `systemd-analyze verify` — همه روی همین مخزن اجرا شده‌اند و خروجی‌شان در متن
> آمده. آنچه روی یک سرور واقعیِ بابل هنوز اجرا نشده: nginx و certbot. آن بخش
> الگوست، نه گزارش.

## فهرست

- [شکل استقرار](#شکل)
- [پیش‌نیازهای سرور](#پیشنیازها)
- [گام ۱ — پایگاه داده و دو نقش](#گام-۱)
- [گام ۲ — کد و ساخت](#گام-۲)
- [گام ۳ — migration](#گام-۳)
- [گام ۴ — فایل‌های محیط](#گام-۴)
- [گام ۵ — systemd](#گام-۵)
- [گام ۶ — nginx و TLS](#گام-۶)
- [تأیید استقرار](#تأیید)
- [پشتیبان‌گیری و بازگردانی](#پشتیبان)
- [انتشار نسخهٔ جدید](#انتشار)
- [عقب‌گرد](#عقبگرد)
- [چه چیزی را رصد کنیم](#رصد)
- [چک‌لیست روز اول](#چکلیست)

<a id="شکل"></a>

## شکل استقرار

یک سرور، چهار چیز روی آن:

| چه چیزی    | کجا                | چطور اجرا می‌شود         |
| ---------- | ------------------ | ------------------------ |
| PostgreSQL | ۵۴۳۲، فقط loopback | بستهٔ سیستم‌عامل         |
| API        | ۳۰۰۱، فقط loopback | systemd — `alo-noon-api` |
| سایت و پنل | ۳۲۰۰، فقط loopback | systemd — `alo-noon-web` |
| nginx      | ۴۴۳ و ۸۰، عمومی    | بستهٔ سیستم‌عامل         |

هیچ‌کدام از سه سرویس اول مستقیم از اینترنت در دسترس نیستند. تنها راه ورود nginx
است، و این یک تصمیم امنیتی است نه سلیقه — بخش [گام ۵](#گام-۵) توضیح می‌دهد چرا.

**یک فرایند API، نه بیشتر.** دو زمان‌بند داخل همین فرایند کار می‌کنند: یکی هر ۶۰
ثانیه پرداخت‌های ته‌مانده را تسویه می‌کند و یکی هر ۱۵ ثانیه رویدادهای دامنه را
به پیامک تبدیل می‌کند. اجرای چند فرایند خطرناک نیست — هر دو idempotent‌اند و
نویسندهٔ دوم رد می‌شود — ولی بی‌فایده است. تا وقتی یک شهر است، یکی کافی است.

<a id="پیشنیازها"></a>

## پیش‌نیازهای سرور

- Ubuntu 22.04 یا Debian 12
- Node.js 22 (همان نسخه‌ای که `target` بستهٔ ساخت روی آن تنظیم شده)
- PostgreSQL 16
- pnpm 11
- nginx و certbot
- یک کاربر سیستمی بدون shell برای اجرای سرویس‌ها:

```bash
adduser --system --group --no-create-home --shell /usr/sbin/nologin alo-noon
```

مسیر `node` را یک‌بار بررسی کنید؛ فایل‌های systemd روی `/usr/bin/node` تنظیم
شده‌اند:

```bash
command -v node    # اگر چیز دیگری بود، ExecStart را اصلاح کنید
```

<a id="گام-۱"></a>

## گام ۱ — پایگاه داده و دو نقش

> [!CAUTION] **مهم‌ترین بند این سند.** جداسازی مشتری‌ها روی row-level security
> بنا شده، و PostgreSQL نقش superuser، نقش `BYPASSRLS` و **مالک جدول** را از
> سیاست‌ها معاف می‌کند. اگر API با نقشی وصل شود که migration را اجرا کرده، همهٔ
> policyها بی‌سروصدا از کار می‌افتند — نه خطایی، نه هشداری. پس **دو نقش لازم
> است**: یکی برای migration، یکی برای سرویس.

```bash
sudo -u postgres createdb alo_noon
sudo -u postgres createuser --pwprompt alo_noon_migrate
sudo -u postgres psql -d alo_noon -c \
  'ALTER DATABASE alo_noon OWNER TO alo_noon_migrate'
```

نقش سرویس بعد از اولین migration ساخته می‌شود (گام ۳)، چون فایلش به جدول‌های
موجود دسترسی می‌دهد.

<a id="گام-۲"></a>

## گام ۲ — کد و ساخت

```bash
install -d -o alo-noon -g alo-noon /srv/alo-noon
cd /srv/alo-noon
git clone https://github.com/tecpey/---Alo-Noon.git releases/$(date -u +%Y%m%dT%H%M%SZ)
cd releases/*
pnpm install --frozen-lockfile
pnpm --filter @alo-noon/database exec prisma generate
pnpm build

# خروجی standalone نکست، دو پوشه را با خود نمی‌آورد. باید دستی کپی شوند:
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public       apps/web/.next/standalone/apps/web/public

ln -sfn "$PWD" /srv/alo-noon/current
```

چهار نکته دربارهٔ این فرمان‌ها:

**`prisma generate` اختیاری نیست.** کلاینت Prisma کد تولیدشده‌ای است کنار یک
موتور native، و تنها چیزی است که از بستهٔ ساخت بیرون می‌ماند. بدون این گام،
سرویس بالا نمی‌آید.

**`pnpm build` سرویس را بسته‌بندی می‌کند.** خروجی `apps/api/dist/server.js` است
و با `node` خالی اجرا می‌شود — نه loader، نه کامپایلر در production. ابزار
provision هم به همان شکل در `dist/provision.js` می‌آید، چون روی سرور هیچ dev
dependencyای نصب نیست.

**دو `cp` را جا نیندازید.** نکست در حالت standalone فقط سرور و node_modulesِ
لازم را کپی می‌کند؛ `.next/static` و `public` را نمی‌آورد. اگر کپی نشوند سایت
بالا می‌آید ولی **هر CSS و هر تصویر ۴۰۴ می‌شود** — صفحه‌ای بی‌قالب که شبیه
خرابیِ سرور نیست و همین آن را گیج‌کننده می‌کند. در [تأیید استقرار](#تأیید) یک
بررسی برای همین هست.

**نصب در پوشهٔ تاریخ‌دار و symlink به `current`.** [عقب‌گرد](#عقبگرد) به همین
تکیه می‌کند: نسخهٔ قبلی هنوز روی دیسک است و برگشتن یعنی جابه‌جا کردن یک لینک.

<a id="گام-۳"></a>

## گام ۳ — migration

با نقش migration، نه نقش سرویس:

```bash
cd /srv/alo-noon/current/packages/database
DATABASE_URL='postgresql://alo_noon_migrate:<رمز>@127.0.0.1:5432/alo_noon' \
  pnpm exec prisma migrate deploy
```

سپس نقش کم‌دسترسی سرویس را یک‌بار بسازید:

```bash
sudo -u postgres psql -d alo_noon -f \
  /srv/alo-noon/current/packages/database/sql/production-role.sql
sudo -u postgres psql -d alo_noon -c \
  "ALTER ROLE alo_noon_app PASSWORD '<رمز>'"
```

رمز را جدا بدهید تا در هیچ فایلی ننشیند. فایل SQL خودش توضیح می‌دهد چرا این نقش
نه superuser است، نه `BYPASSRLS` دارد، و نه مالک چیزی است — سه راه جداگانه برای
معاف شدن از سیاست‌ها، و هر سه بسته شده.

<a id="گام-۴"></a>

## گام ۴ — فایل‌های محیط

```bash
install -d -m 0750 -o root -g alo-noon /etc/alo-noon
```

هر دو فایل زیر رمز دارند، پس:

```bash
chown root:alo-noon /etc/alo-noon/api.env /etc/alo-noon/web.env
chmod 0640 /etc/alo-noon/api.env /etc/alo-noon/web.env
```

### `/etc/alo-noon/api.env`

| متغیر                                                           | مقدار                | چرا                                                                                                 |
| --------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                      | `production`         | چند محافظ را روشن می‌کند؛ بدون آن سرویس `/ready` نمی‌دهد                                            |
| `DATABASE_URL`                                                  | نقش `alo_noon_app`   | **نه** نقش migration                                                                                |
| `API_HOST`                                                      | `127.0.0.1`          | پیش‌فرض `0.0.0.0` است و برای container درست است؛ روی این سرور یعنی API از اینترنت هم پاسخ می‌دهد    |
| `API_PORT`                                                      | `3001`               |                                                                                                     |
| `API_TRUST_PROXY_HOPS`                                          | `1`                  | یک nginx در مسیر است. حدس‌زدنش محدودیت نرخ و شمارش سوءاستفادهٔ OTP را از کار می‌اندازد              |
| `AUTH_OTP_PEPPER` / `AUTH_SESSION_PEPPER` / `AUTH_ABUSE_PEPPER` | هر سه **متفاوت**     | مقدار موقت یعنی همهٔ نشست‌ها با هر ری‌استارت باطل شوند                                              |
| `PAYMENT_SECRET_ENCRYPTION_KEY`                                 | کلید ساخته‌شده       | جدا از مقادیر رمزشده نگه دارید                                                                      |
| `PAYMENT_CALLBACK_BASE_URL`                                     | `https://<domain>`   | درگاه از اینترنت به این آدرس برمی‌گردد                                                              |
| `PAYMENT_RESULT_REDIRECT_URL`                                   | `https://<domain>/…` | جایی که مشتری بعد از پرداخت می‌بیند                                                                 |
| `CORS_ORIGINS`                                                  | `https://<domain>`   |                                                                                                     |
| `SENTRY_DSN`                                                    | اختیاری              | بدون آن خطاها فقط در journal می‌مانند                                                               |
| `EMAIL_<NAME>`                                                  | URL کامل SMTP        | برای هشدارهای عملیاتی؛ مثل `smtps://user:pass@mail.example.com:465`. نامش باید با `EMAIL_` شروع شود |

سه pepper را این‌طور بسازید — هر کدام یک بار، و هرگز دوباره:

```bash
for name in AUTH_OTP_PEPPER AUTH_SESSION_PEPPER AUTH_ABUSE_PEPPER; do
  printf '%s=%s\n' "$name" "$(openssl rand -base64 32)"
done >> /etc/alo-noon/api.env
```

> [!WARNING] **عوض کردن `AUTH_SESSION_PEPPER` همهٔ کاربران را بیرون می‌اندازد.**
> نه به‌عنوان خطا؛ به‌عنوان طراحی. اگر لازم شد عوضش کنید، بدانید که هر مشتری و
> هر اپراتور باید دوباره کد بگیرد — و گرفتن کد یعنی پیامک، یعنی هزینه.

### `/etc/alo-noon/web.env`

| متغیر                | مقدار                   |
| -------------------- | ----------------------- |
| `NODE_ENV`           | `production`            |
| `PORT`               | `3200`                  |
| `HOSTNAME`           | `127.0.0.1`             |
| `API_BASE_URL`       | `http://127.0.0.1:3001` |
| `ADMIN_API_BASE_URL` | `http://127.0.0.1:3001` |

سایت از داخل همان ماشین با API حرف می‌زند، پس آدرس داخلی درست است و از nginx و
TLS عبور نمی‌کند — یک پرش کمتر برای هر صفحه.

<a id="گام-۵"></a>

## گام ۵ — systemd

```bash
cp /srv/alo-noon/current/deploy/alo-noon-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now alo-noon-api alo-noon-web
systemctl status alo-noon-api --no-pager
```

فایل‌ها در `deploy/` مخزن‌اند و با `systemd-analyze verify` بررسی شده‌اند. چند
نکته که در خودشان هم کامنت شده:

- **`SIGTERM` کافی است.** سرویس هر دو زمان‌بند و Fastify را می‌بندد و اتصال
  پایگاه داده را قطع می‌کند. `systemctl stop` یعنی توقف تمیز، نه kill.
- **`StartLimitIntervalSec` در `[Unit]` است، نه `[Service]`.** systemd آن را زیر
  `[Service]` بی‌صدا نادیده می‌گیرد — یعنی محدودیتی که فکر می‌کنید دارید،
  ندارید. این یکی را `systemd-analyze verify` گرفت.
- **`ProtectSystem=strict` و بقیهٔ بندهای سخت‌سازی.** سرویس فقط یک بسته می‌خواند
  و جز لاگ چیزی نمی‌نویسد؛ این بندها فاصلهٔ میان یک فرایند در معرض خطر و یک
  ماشین در معرض خطر است.

<a id="گام-۶"></a>

## گام ۶ — nginx و TLS

```bash
cp /srv/alo-noon/current/deploy/nginx.conf.example \
   /etc/nginx/sites-available/alo-noon
# هر <domain> را جایگزین کنید
ln -s ../sites-available/alo-noon /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <domain> -d www.<domain>
```

سه چیز در آن فایل واقعاً اهمیت دارند:

**سه هدر `X-Forwarded-*`.** API دقیقاً یک پرش پروکسی معتبر می‌شمارد و نشانی
مشتری را از `X-Forwarded-For` می‌خواند. اگر این هدرها نروند، همهٔ شهر در یک سطل
محدودیت نرخ و یک شمارندهٔ سوءاستفادهٔ OTP می‌افتند — یعنی اولین کسی که کد
می‌خواهد، بقیه را قفل می‌کند.

**`proxy_buffering off` روی `/api/`.** بازگشت درگاه پرداخت از همین‌جا می‌آید و
نباید نیمه‌کاره قطع شود؛ یک verify که وسط راه بریده شود یعنی پولی که از مشتری
گرفته شده و ثبت نشده.

**`/ready` و `/health` فقط از خود ماشین.** پاسخ `/ready` وضعیت پایگاه داده و
سرویس پیامک را می‌گوید؛ این اطلاعات مجانی برای هر کسی که بپرسد نیست.

<a id="تأیید"></a>

## تأیید استقرار

```bash
curl -fsS http://127.0.0.1:3001/ready | jq .
```

باید هر دو بررسی `true` باشند:

```json
{
  "checks": [
    { "name": "database", "ready": true },
    { "name": "authentication-delivery", "ready": true }
  ]
}
```

- `database: false` → اتصال ممتاز است، یا RLS روی جداول احراز هویت `FORCE` نشده.
  به [گام ۱](#گام-۱) برگردید.
- `authentication-delivery: false` → هیچ سرویس پیامک واقعی ثبت نشده. در
  production یعنی هیچ کاربری کد دریافت نمی‌کند. این را
  [راهنمای عملیات](ADMIN_OPERATIONS_GUIDE_FA.md) درست می‌کند.

بررسی اینکه API واقعاً فقط روی loopback گوش می‌دهد:

```bash
ss -ltn | grep 3001
```

باید **فقط یک سطر** با `127.0.0.1:3001` ببینید. اگر `0.0.0.0:3001` دیدید،
`API_HOST` تنظیم نشده و API از اینترنت هم پاسخ می‌دهد — یعنی بدون TLS و بدون
هدرهای پروکسی.

و بررسی اینکه فایل‌های ایستا واقعاً سرو می‌شوند — نه فقط اینکه صفحه ۲۰۰ می‌دهد.
**هر دو مسیر را جدا بررسی کنید**؛ `.next/static` و `public` دو کپی مستقل‌اند و
یکی می‌تواند سالم باشد و آن یکی نه:

```bash
CSS=$(curl -s http://127.0.0.1:3200/ | grep -o '/_next/static/[^"]*\.css' | head -1)
curl -s -o /dev/null -w 'css %{http_code}\n' "http://127.0.0.1:3200$CSS"
curl -s -o /dev/null -w 'font %{http_code}\n' \
  http://127.0.0.1:3200/fonts/vazirmatn-400.woff2
```

اگر هرکدام ۴۰۴ داد، `cp` متناظرش در گام ۲ انجام نشده است. صفحهٔ اصلی همچنان ۲۰۰
می‌دهد و همین است که خطا را دیر آشکار می‌کند.

> [!WARNING] **۴۰۴ شدن فونت، خرابیِ ساکت است.** وزیرمتن self-host شده؛ اگر
> `public` کپی نشده باشد کل رابط به Tahoma می‌افتد. صفحه بالا می‌آید، چیزی قرمز
> نمی‌شود، و تنها نشانه‌اش این است که فارسی «یک‌جوری» به نظر می‌رسد. این‌جا در
> آزمون واقعی همین اتفاق افتاد — درحالی‌که `.next/static` سالم بود.

<a id="پشتیبان"></a>

## پشتیبان‌گیری و بازگردانی

سفارش‌ها، دفتر مالی و دفترچهٔ نشانی هر مشتری در یک پایگاه دادهٔ واحدند و هیچ
نسخهٔ دومی از هیچ‌کدام وجود ندارد.

```bash
crontab -u postgres -e
# 15 3 * * *  /srv/alo-noon/current/deploy/backup.sh
```

اسکریپت در `deploy/backup.sh` است، دو هفته نگه می‌دارد، و هر دامپ را بلافاصله با
`pg_restore --list` می‌خواند — چون فایلی که خوانده نشده باشد، پشتیبان نیست،
فرضیه است.

### بازگردانی

**این را قبل از لانچ یک‌بار تمرین کنید.** روی همین مخزن اجرا و تأیید شده:

```bash
createdb alo_noon_restore_check
pg_restore --dbname=alo_noon_restore_check --no-owner --no-privileges <dump>
```

و بعد — مهم‌ترین بخش — بررسی کنید که جداسازی مشتری‌ها زنده مانده باشد:

```sql
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relforcerowsecurity;
```

هر دو عدد باید با پایگاه دادهٔ اصلی یکی باشند. در آزمایش این مخزن هر دو ۶۶
بودند، به‌علاوهٔ ۴۶ trigger و ۴۰ function که همه سالم برگشتند. **بازگردانی‌ای که
policyها را از دست بدهد، پایگاه دادهٔ سالمی می‌سازد که مشتری‌ها را از هم جدا
نمی‌کند** — و هیچ خطایی هم نمی‌دهد.

<a id="انتشار"></a>

## انتشار نسخهٔ جدید

ترتیب اهمیت دارد:

```bash
cd /srv/alo-noon/releases
git clone --depth 1 <repo> $(date -u +%Y%m%dT%H%M%SZ) && cd $_
pnpm install --frozen-lockfile
pnpm --filter @alo-noon/database exec prisma generate
pnpm build

# ۱. پشتیبان، پیش از هر migration
sudo -u postgres /srv/alo-noon/current/deploy/backup.sh

# ۲. migration با نقش migration
cd packages/database && DATABASE_URL='...alo_noon_migrate...' \
  pnpm exec prisma migrate deploy && cd ../..

# ۳. جابه‌جایی لینک و ری‌استارت
ln -sfn "$PWD" /srv/alo-noon/current
systemctl restart alo-noon-api alo-noon-web

# ۴. تأیید
curl -fsS http://127.0.0.1:3001/ready | jq .
```

پشتیبان **پیش از** migration گرفته می‌شود، نه بعد از آن. یک migration که بد پیش
برود، پشتیبانِ بعد از خودش را هم بی‌فایده می‌کند.

<a id="عقبگرد"></a>

## عقب‌گرد

اگر migration نبوده:

```bash
ln -sfn /srv/alo-noon/releases/<نسخهٔ قبلی> /srv/alo-noon/current
systemctl restart alo-noon-api alo-noon-web
```

اگر migration بوده، عقب‌گرد به این سادگی **نیست**. Prisma فرمان `migrate down`
ندارد و طرح پایگاه داده جلو رفته است. دو حالت:

- **migration افزودنی بوده** (جدول یا ستون تازه): کد قبلی معمولاً با طرح جدید
  کار می‌کند، چون چیزی را که نمی‌شناسد نمی‌خواند. لینک را برگردانید و ری‌استارت
  کنید.
- **migration تخریبی بوده** (ستون حذف یا نامش عوض شده): تنها راه امن، بازگردانی
  از پشتیبانِ پیش از انتشار است — و هر سفارشی که بعد از آن ثبت شده از دست
  می‌رود. به همین دلیل انتشارهایی که migration تخریبی دارند باید در ساعت خلوت
  انجام شوند، نه صبح.

<a id="رصد"></a>

## چه چیزی را رصد کنیم

```bash
journalctl -u alo-noon-api -f
```

سه سطر که معنای مشخصی دارند:

| در لاگ                                           | یعنی                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Payment callbacks still awaiting settlement`    | پرداختی از مشتری گرفته شده و هنوز ثبت نشده. یک‌بار عادی است؛ تکرار در چند چرخه یعنی درگاه مشکل دارد  |
| `Domain events exhausted their publish attempts` | رویدادهایی که دیگر کسی تلاش نمی‌کند بفرستد — هر کدام یک مشتری که خبردار نشد. **این خطاست، نه هشدار** |
| `Outbox publish sweep failed`                    | معمولاً پایگاه داده در دسترس نیست                                                                    |

و یک بررسی روزانه که ارزشش را دارد:

```bash
curl -fsS http://127.0.0.1:3001/ready | jq -e '.data.ready'
df -h /var/lib/postgresql
ls -la /var/backups/alo-noon | tail -3
```

<a id="چکلیست"></a>

## چک‌لیست روز اول

بندهای زیربنایی. بندهای کسب‌وکاری — درگاه، پیامک، کاتالوگ، اپراتورها — در
[چک‌لیست سافت‌لانچ](ADMIN_OPERATIONS_GUIDE_FA.md#چکلیست) است و **هر دو** باید
تمام باشند.

- [ ] `ss -ltn` نشان می‌دهد ۳۰۰۱ و ۳۲۰۰ فقط روی loopback‌اند
- [ ] `curl https://<domain>` گواهی معتبر می‌دهد و به HTTPS هدایت می‌شود
- [ ] `/ready` هر دو بررسی را `true` می‌دهد
- [ ] یک فایل CSS از `/_next/static/` ۲۰۰ می‌دهد (نه فقط صفحهٔ اصلی)
- [ ] `/fonts/vazirmatn-400.woff2` ۲۰۰ می‌دهد — کپیِ `public` جداست و جدا خراب
      می‌شود
- [ ] API با نقش `alo_noon_app` وصل است، نه نقش migration
- [ ] `API_TRUST_PROXY_HOPS=1` و nginx هر سه هدر `X-Forwarded-*` را می‌فرستد
- [ ] سه pepper مقدار مستقل دارند و جایی امن ثبت شده‌اند
- [ ] cron پشتیبان‌گیری فعال است و **یک‌بار دستی اجرا شده**
- [ ] **یک بازگردانی تمرین شده** و شمارش policy با اصلی خوانده
- [ ] `systemctl enable` برای هر دو سرویس زده شده، و ری‌استارت سرور آزموده شده
- [ ] نسخهٔ قبلی روی دیسک مانده تا عقب‌گرد ممکن باشد
