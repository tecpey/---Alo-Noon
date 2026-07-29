# Notification, Print & Label Architecture

## هدف

این سند معماری اعلان چندنقشی، چاپ خودکار سفارش و لیبل بسته‌بندی را برای مشتری،
نانوایی، پیک و تیم عملیات تعریف می‌کند. این قابلیت بخشی از هسته سفارش و
fulfillment است و نباید به‌صورت افزونه نمایشی یا وابسته به یک چاپگر خاص ساخته
شود.

## نقش‌ها و کانال‌ها

### مشتری

- ثبت موفق سفارش
- پرداخت موفق یا ناموفق
- پذیرش سفارش توسط نانوایی
- شروع تولید یا Oven Finish
- آماده‌شدن سفارش
- تخصیص و حرکت پیک
- تعداد توقف‌های باقی‌مانده و ETA
- تاخیر، تغییر یا لغو
- تحویل و درخواست بازخورد

### نانوایی

- سفارش جدید با اعلان صوتی و تصویری
- نزدیک‌شدن به سقف ظرفیت
- سفارش در خطر تاخیر
- خطای چاپ یا اتمام کاغذ/لیبل
- پیک در راه یا منتظر دریافت
- تغییر یا لغو مجاز سفارش
- پیام دستی عملیات

### پیک

- ماموریت جدید
- تغییر در بسته‌ها یا ترتیب توقف‌ها
- سفارش آماده دریافت
- هشدار عدم حرکت، تاخیر یا خروج از مسیر
- دستور تماس امن یا عدم حضور مشتری
- پیام دستی مرکز عملیات

### عملیات و پشتیبانی

- سفارش بدون پذیرش
- SLA در خطر
- چاپ ناموفق
- پیک تخصیص‌نیافته
- اختلاف اسکن بسته و ماموریت
- تحویل ناموفق
- Retryهای بیش از حد
- رخداد امنیتی یا تغییر حساس

## گونه‌های اعلان

1. **Transactional**: مستقیماً ناشی از رویداد سفارش و غیرقابل خاموش‌کردن در
   موارد حیاتی.
2. **Operational**: هشدارهای نانوایی، پیک و تیم عملیات.
3. **Smart/Rule-based**: بر اساس ظرفیت، تاخیر، رفتار و شرایط عملیاتی.
4. **Manual**: پیام هدفمند اپراتور با ثبت فرستنده، مخاطب، دلیل و زمان.
5. **Marketing**: فقط با رضایت و ترجیحات کاربر.

## معماری رویداد

```text
Domain transaction
  └─ writes Order/Payment/Production state
  └─ writes OutboxEvent in same database transaction
        └─ event publisher
              ├─ Notification Orchestrator
              ├─ Print Orchestrator
              ├─ CRM Event Consumer
              └─ Analytics Consumer
```

اصول:

- رویدادها باید versioned باشند.
- مصرف‌کننده‌ها باید idempotent باشند.
- هیچ چاپ یا پیام حیاتی نباید فقط بر WebSocket یا حافظه فرآیند متکی باشد.
- هر تلاش ارسال، نتیجه، خطا، provider و correlation ID ثبت می‌شود.
- Retry با backoff و Dead Letter Queue انجام می‌شود.

## رویدادهای پایه

```text
order.confirmed.v1
order.cancelled.v1
payment.authorized.v1
production.accepted.v1
production.started.v1
production.ready.v1
courier.assigned.v1
shipment.picked_up.v1
route.resequenced.v1
shipment.delivered.v1
print.requested.v1
print.completed.v1
print.failed.v1
notification.requested.v1
notification.delivered.v1
notification.failed.v1
```

## جریان تایید و چاپ سفارش

1. سفارش تنها پس از عبور از validation، رزرو ظرفیت و وضعیت معتبر مالی به
   `CONFIRMED` می‌رسد.
2. همان تراکنش، `order.confirmed.v1` را در Outbox ثبت می‌کند.
3. Print Orchestrator سیاست شعبه و نوع محصول را ارزیابی می‌کند.
4. یک یا چند `PrintJob` با idempotency key ایجاد می‌شود.
5. Bakery Print Agent کار را دریافت می‌کند و قالب نسخه‌دار را render می‌کند.
6. چاپگر نتیجه را اعلام می‌کند.
7. موفقیت یا خطا ثبت و به پنل نانوایی/عملیات اعلام می‌شود.
8. چاپ مجدد فقط با permission، reason و Audit Log انجام می‌شود.

## انواع سند چاپی

### Kitchen Order Ticket

برای صف تولید و آماده‌سازی:

- شماره سفارش
- زمان پذیرش و SLA
- اقلام و تعداد
- تغییرات و گزینه‌های پخت
- Oven Finish
- آلرژن‌ها و یادداشت عملیاتی
- Batch/slot پیشنهادی
- QR برای تغییر وضعیت سریع

### Adhesive Package Label

برای چسباندن روی هر بسته:

- Order short code و Package sequence مانند `2/5`
- نام یا نام کوتاه گیرنده
- شماره تماس ماسک‌شده یا secure-contact token
- آدرس خلاصه و دستور تحویل
- اقلام همان بسته
- شعبه، زمان آماده‌شدن و هشدار نگهداری
- Route stop sequence پس از تخصیص پیک
- QR/Barcode شامل شناسه opaque؛ نه اطلاعات شخصی خام
- Template version، print timestamp و printer ID

### Courier Manifest

در صورت نیاز برای شریک پیک یا عملیات آفلاین:

- شناسه ماموریت
- فهرست بسته‌ها
- ترتیب توقف‌ها
- وضعیت اسکن دریافت
- QR هر بسته
- اطلاعات حداقلی لازم برای تحویل

## حریم خصوصی لیبل

- شماره تماس کامل به‌صورت پیش‌فرض چاپ نمی‌شود.
- QR نباید نام، تلفن یا آدرس را به‌صورت plaintext حمل کند.
- آدرس چاپی باید متناسب با نیاز تحویل باشد.
- برای سفارش هدیه یا خانوار، گیرنده و پرداخت‌کننده تفکیک می‌شوند.
- قالب‌ها retention policy و classification داده دارند.

## مدل داده پیشنهادی

```text
NotificationTemplate
NotificationPreference
NotificationCampaign
NotificationMessage
NotificationAttempt
NotificationDelivery

Printer
PrinterCapability
PrintTemplate
PrintPolicy
PrintJob
PrintAttempt
PrintedDocument

Package
PackageItem
PackageLabel
Shipment
Route
RouteStop
PackageScan
```

فیلدهای کلیدی `PrintJob`:

```text
id
branchId
orderId
packageId?
templateId
templateVersion
idempotencyKey
payloadSnapshot
status
priority
printerId?
requestedAt
claimedAt?
printedAt?
failedAt?
retryCount
lastErrorCode?
requestedByType
requestedById?
correlationId
```

## Print Agent نانوایی

Print Agent یک سرویس محلی یا اپ کنترل‌شده است که:

- با credential محدود به شعبه احراز هویت می‌شود.
- فقط Jobهای همان شعبه را دریافت می‌کند.
- heartbeat و وضعیت چاپگر را ارسال می‌کند.
- از چاپگرهای حرارتی/لیبل استاندارد از طریق adapter پشتیبانی می‌کند.
- قالب را از payload نسخه‌دار تولید می‌کند.
- در قطعی کوتاه شبکه، صف محلی رمزنگاری‌شده و محدود دارد.
- پس از اتصال، نتیجه را sync می‌کند.

اتصال مستقیم API عمومی به IP چاپگر ممنوع است.

## حالات خطا و بازیابی

- چاپگر آفلاین: هشدار فوری، Retry و امکان انتخاب چاپگر جایگزین.
- کاغذ یا لیبل تمام: وضعیت `BLOCKED_SUPPLIES` و هشدار نانوا.
- چاپ ناقص: چاپ مجدد با reason و void کردن نسخه قبلی.
- رویداد تکراری: همان idempotency key، بدون چاپ دوباره.
- لغو پس از چاپ: چاپ برچسب VOID یا هشدار واضح در پنل.
- تغییر سفارش پس از چاپ: ایجاد نسخه جدید و باطل‌کردن نسخه قبل.
- قطعی Agent: Job در سرور باقی می‌ماند و SLA alert فعال می‌شود.

## اعلان دستی

پنل مدیریت باید امکان انتخاب این موارد را داشته باشد:

- مخاطب: کاربر، گروه، نانوایی، شعبه، پیک، شهر یا منطقه
- کانال
- فوریت
- بازه ارسال
- متن و قالب تاییدشده
- دلیل کسب‌وکاری
- لینک یا action امن

ارسال دستی نیازمند permission، ثبت Audit Log و محدودیت نرخ است. پیام‌های انبوه
حساس می‌توانند نیازمند تایید دوم باشند.

## امنیت

- Service credential جدا برای هر Print Agent
- Rotation و revocation
- TLS و امضای درخواست‌های حساس
- Tenant/scope enforcement در API
- جلوگیری از replay
- Audit برای چاپ مجدد و اعلان دستی
- عدم قرارگیری PII در logهای عمومی
- کنترل دسترسی قالب‌ها و payload snapshots

## معیارهای پذیرش MVP

- سفارش تاییدشده حداکثر یک Job اصلی چاپ ایجاد کند.
- Duplicate event موجب چاپ دوباره نشود.
- خطای چاپ ظرف چند ثانیه در پنل نانوایی و عملیات دیده شود.
- چاپ مجدد بدون permission و reason ممکن نباشد.
- نانوا اعلان سفارش جدید را دریافت و acknowledge کند.
- پیک فقط اطلاعات لازم برای ماموریت خود را ببیند.
- تمام پیام‌ها و چاپ‌های حیاتی trace و audit شوند.
- با قطعی موقت شبکه، سفارش یا Job از بین نرود.

## فازبندی

### MVP بابل

- Web/PWA Bakery Console
- یک Print Agent کنترل‌شده
- چاپگر لیبل حرارتی منتخب
- اعلان داخل پنل، Push و پیامک fallback برای رخدادهای حیاتی
- چاپ Kitchen Ticket و Package Label
- مانیتور خطا و چاپ مجدد کنترل‌شده

### فاز بعد

- چند چاپگر در هر شعبه
- routing چاپ بر اساس ایستگاه تولید
- چاپ Manifest پیک
- قالب‌های چندزبانه
- provider abstraction برای Push/SMS
- Smart escalation و پیش‌بینی خرابی
