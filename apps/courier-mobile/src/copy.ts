/**
 * The words on the way in.
 *
 * A courier opening this app is either starting a shift or checking whether
 * anything came in, so the sign-in screen says what the app is for rather than
 * greeting them. Everything after sign-in describes real orders and is written
 * where those orders are rendered.
 */
export const courierCopy = {
  title: 'ورود پیک',
  subtitle: 'سفارش‌های آماده و مسیر تحویل خود را اینجا ببینید و ثبت کنید.',

  /*
    A tap that could not reach the shop.

    Written as something that has happened, not as a failure: the courier's job
    is done and the phone is holding the message. The old behaviour was an error
    and nothing else, which sent a rider back up a stairwell to press a button
    that had in fact worked.
  */
  queuedFa: 'اینترنت نبود. ثبت شد و به‌محض وصل‌شدن فرستاده می‌شود.',
  /* Held too long to send honestly — the timestamp would be wrong. */
  staleFa: 'یک ثبت خیلی طول کشید و فرستاده نشد. لطفاً دوباره ثبتش کنید.',
  /** The count in the banner. `%s` is the number, already in Persian digits. */
  waitingFa: (count: string) => `%s ثبت در صف ارسال`.replace('%s', count),
} as const
