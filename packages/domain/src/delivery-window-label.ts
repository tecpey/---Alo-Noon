const TEHRAN = 'Asia/Tehran'

/**
 * A delivery window, in the words a customer would use for it.
 *
 * Lives in the domain for the same reason `orderProgress` does: the site and
 * the phone both offer windows, and a customer who books "فردا ۸ تا ۱۰" on one
 * must be shown the same words by the other. A repository rule forbids one
 * application importing another, so the only alternative is two copies that
 * drift.
 *
 * "امروز ۸ تا ۱۰" rather than a pair of timestamps. Somebody choosing when
 * their bread arrives is picking between this morning and tomorrow morning, and
 * a date they have to decode is a date they misread — which here means a
 * customer standing at the door on the wrong day.
 *
 * The relative words only stretch as far as they are unambiguous. Past
 * tomorrow, the Jalali date is named outright: "پس‌فردا" is a word people
 * disagree about often enough that a bakery should not schedule an oven on it.
 */
export function formatDeliveryWindow(startsAt: string, endsAt: string, now: Date): string {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  return `${dayLabel(start, now)} ${hour(start)} تا ${hour(end)}`
}

/** Just the day, for grouping windows under a heading. */
export function formatWindowDay(startsAt: string, now: Date): string {
  return dayLabel(new Date(startsAt), now)
}

function dayLabel(instant: Date, now: Date): string {
  const day = calendarDay(instant)
  if (day === calendarDay(now)) return 'امروز'
  if (day === calendarDay(new Date(now.getTime() + 86_400_000))) return 'فردا'
  return new Intl.DateTimeFormat('fa-IR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TEHRAN,
  }).format(instant)
}

/**
 * The city's calendar day for an instant, as `YYYY-MM-DD`.
 *
 * Compared as strings rather than by subtracting dates: at half past eleven at
 * night in Tehran it is already tomorrow locally but still today in UTC, and a
 * comparison that ignores that labels tomorrow's first window "امروز".
 */
function calendarDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

function hour(instant: Date): string {
  return new Intl.DateTimeFormat('fa-IR', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: TEHRAN,
  }).format(instant)
}
