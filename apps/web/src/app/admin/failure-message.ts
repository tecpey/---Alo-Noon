/**
 * Persian text for a failed admin read.
 *
 * A permission denial gets its own wording because it is the one an operator can
 * act on — someone has to grant them the role — while everything else is either
 * transient or a bug. An unrecognised code is shown verbatim rather than hidden:
 * during setup it is often the only thing that says what went wrong.
 */
export function readFailureMessage(code: string): string {
  switch (code) {
    case 'ADMIN_PERMISSION_DENIED':
    case 'PAYMENT_PROVIDER_OPERATION_FORBIDDEN':
    case 'AUTH_DELIVERY_PROVIDER_OPERATION_FORBIDDEN':
      return 'این حساب دسترسی لازم برای دیدن این بخش را ندارد. دسترسی باید روی حساب شما ثبت شود.'
    case 'API_UNREACHABLE':
      return 'ارتباط با سرویس برقرار نشد.'
    case 'REPORTING_UNAVAILABLE':
    case 'PROVIDER_GOVERNANCE_UNAVAILABLE':
      return 'سرویس موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.'
    case 'REPORT_RANGE_TOO_WIDE':
      return 'بازهٔ انتخابی بیش از حد طولانی است.'
    case 'ORDER_NOT_FOUND':
      return 'چنین سفارشی در این tenant وجود ندارد.'
    default:
      return `خواندن اطلاعات ناموفق بود (${code}).`
  }
}
