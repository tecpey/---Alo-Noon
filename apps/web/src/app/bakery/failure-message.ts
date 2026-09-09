/**
 * Persian text for a failed read on the bakery panel.
 *
 * The one that matters is `BRANCH_ACCESS_DENIED`: it is what a partner sees the
 * first time they sign in, before anybody has granted them a branch, and it has
 * to say that the sign-in worked and the access is what is missing. "Forbidden"
 * on its own reads as "you typed the wrong number" and sends them back to try
 * again forever.
 */
export function branchFailureMessage(code: string): string {
  switch (code) {
    case 'BRANCH_ACCESS_DENIED':
      return 'ورود شما انجام شد، ولی این حساب هنوز روی هیچ شعبه‌ای دسترسی ندارد. مدیر پلتفرم باید شمارهٔ شما را به شعبه وصل کند.'
    case 'ADMIN_PERMISSION_DENIED':
      return 'این حساب دسترسی لازم برای دیدن این بخش را ندارد.'
    case 'API_UNREACHABLE':
      return 'ارتباط با سرویس برقرار نشد.'
    case 'BRANCH_UNAVAILABLE':
      return 'پنل نانوایی موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.'
    case 'INVALID_BRANCH_QUERY':
      return 'این نما معتبر نیست.'
    default:
      return `خواندن اطلاعات ناموفق بود (${code}).`
  }
}
