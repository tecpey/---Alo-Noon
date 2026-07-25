# معماری API-first

## اصل مرکزی

تمام کلاینت‌ها و شرکا از قراردادهای API نسخه‌بندی‌شده استفاده می‌کنند. اپ
موبایل، وب، پنل اپراتور، پنل نانوایی، اپ پیک و داشبورد مدیریت نباید منطق مستقل و
متناقض داشته باشند.

## سبک شروع

در MVP از **Modular Monolith** با مرزهای دامنه‌ای روشن استفاده می‌شود. این
انتخاب هزینه عملیات و پیچیدگی توزیع‌شده را پایین نگه می‌دارد، اما قراردادها،
Eventها و ماژول‌ها برای استخراج سرویس‌های مستقل در آینده طراحی می‌شوند.

## دامنه‌ها

- Identity & Access
- Customer & Household CRM
- Catalog & Product
- Bakery & Supplier
- Capacity & Production
- Ordering
- Pricing & Promotions
- Wallet & Ledger
- Logistics Orchestration
- Telephony & Support
- Quality & Incidents
- Notifications
- City & Service Zone
- Analytics & Audit

## الزامات مقیاس

- City-aware configuration
- Provider adapters
- Idempotent commands and webhooks
- Outbox pattern برای انتشار رویدادها
- Queue-backed async work
- Observability and audit correlation IDs
- No partner-specific fields in core order state
- Feature flags by city and partner

## نسخه‌بندی

- مسیر عمومی API با `/api/v1`
- قرارداد OpenAPI پیش از انتشار نخستین endpoint دامنه‌ای عمومی به مخزن افزوده می‌شود
- تغییر شکستن قرارداد نیازمند نسخه جدید یا دوره سازگاری است
- وب‌هوک‌های شریک باید امضا، زمان و idempotency key داشته باشند
