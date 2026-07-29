# نقشه مستندات الو نون

این پوشه منبع تصمیم‌های محصول، عملیات، امنیت و معماری الو نون است. تصمیم‌های مهم
نباید فقط در گفتگو، کد یا حافظه افراد باقی بمانند.

> اسناد هدف و معماری آینده را از قابلیت‌های پیاده‌سازی‌شده تفکیک می‌کنند. وضعیت
> واقعی Phase 1 در `architecture/README.md`، `architecture/DOMAIN_BOUNDARIES.md`
> و اسناد محصول انگلیسی ثبت شده است.

## ترتیب مطالعه برای مدیر محصول و عملیات

1. `00-vision/PRODUCT_VISION_FA.md`
2. `01-product/CATALOG_AND_FRESHNESS_MODEL_FA.md`
3. `02-operations/BABOL_PILOT_OPERATING_MODEL_FA.md`
4. `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`
5. `04-crm/CRM_BLUEPRINT_FA.md`
6. `05-logistics/LOGISTICS_PRICING_AND_PROVIDER_MODEL_FA.md`
7. `07-roadmap/MVP_ROADMAP_FA.md`

## ترتیب مطالعه برای مهندسی

1. `architecture/README.md`
2. `03-architecture/API_FIRST_ARCHITECTURE_FA.md`
3. `03-architecture/DOMAIN_MODEL_FA.md`
4. `architecture/PHASE_1_DOMAIN_FOUNDATION.md`
5. `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`
6. `06-security/SECURITY_BASELINE_FA.md`
7. `decisions/`

## اسناد جدید مرجع

### `architecture/PHASE_1_DOMAIN_FOUNDATION.md`

مرز دامنه‌ها، مدل‌های هدف، State Machine سفارش، RBAC محدوده‌محور، Outbox،
Idempotency، Migration، تست و ترتیب PRهای فاز یک را تعریف می‌کند.

### `operations/NOTIFICATION_PRINT_LABEL_ARCHITECTURE.md`

اعلان‌های هوشمند و دستی برای مشتری، نانوا، پیک و عملیات؛ چاپ خودکار Kitchen
Ticket و لیبل چسبی؛ Print Agent، مدل داده، حریم خصوصی، Retry، خطا و معیار پذیرش
MVP را تعریف می‌کند.

## طبقه‌بندی اسناد

- **Authority**: تصمیم پایه و الزام‌آور؛ تغییر آن نیازمند ADR یا تایید رسمی است.
- **Target Architecture**: وضعیت مطلوب آینده، نه لزوماً وضعیت فعلی.
- **Living Document**: همراه محصول و عملیات به‌روز می‌شود.
- **Runbook**: راهنمای اجرای عملیات یا پاسخ به خطا.
- **Generated**: خروجی خودکار ابزارها و قابل ویرایش دستی نیست.

## قواعد مستندسازی

- قابلیت پیاده‌سازی‌شده و قابلیت برنامه‌ریزی‌شده باید صریحاً تفکیک شوند.
- هر تغییر مدل داده، API، امنیت، پرداخت، چاپ یا لجستیک باید مستند شود.
- تصمیم‌های معماری مهم در `decisions/` به‌صورت ADR ثبت شوند.
- اسناد نباید secret، داده شخصی واقعی یا اطلاعات پرداخت داشته باشند.
- مسیرها، نام‌ها و اصطلاحات باید با کد و قراردادهای API همگام باشند.
- هر PR مهم باید بخش‌های API/data model، security/privacy، operational impact،
  tests و rollback را تکمیل کند.

## وضعیت فعلی

ریپو در Phase 1 Domain Foundation است. مدل دامنه و دیتابیس، قراردادهای نسخه‌دار،
قواعد سفارش/تازگی، Migration، Outbox و Audit foundation همراه تست‌ها پیاده‌سازی
شده‌اند. احراز هویت و RBAC عملیاتی، Commerce تراکنشی، پرداخت، اعلان delivery و
چاپ اجرایی هنوز برنامه‌ریزی‌شده‌اند و نباید قابلیت تحویل‌شده معرفی شوند.

## منابع معتبر Phase 1

1. `product/PRODUCT_REQUIREMENTS.md`
2. `architecture/DOMAIN_BOUNDARIES.md`
3. `architecture/DOMAIN_MODEL.md`
4. `architecture/DOMAIN_EVENT_MODEL.md`
5. `architecture/DATA_OWNERSHIP.md`
6. `architecture/SERVICE_BOUNDARIES.md`
7. `decisions/ADR-0004` تا `ADR-0007`
