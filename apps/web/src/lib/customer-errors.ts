/**
 * A refusal, in words a customer can act on — and never a code.
 *
 * The checkout used to translate its failures with `translateProviderError`,
 * which is the operator panel's translator and ends with `${fallback} (${code})`
 * for anything it does not recognise. That is right for an operator: a code is
 * searchable, and the person reading it can go and look at the provider table.
 * It is wrong for a customer. Measured on the launch tenant, which has no
 * payment gateway configured yet, somebody who chose their bread, typed an
 * address, was quoted and placed an order would reach the last step and be
 * shown:
 *
 *     سفارش ثبت شد اما پرداخت باز نشد. (PAYMENT_PROVIDER_UNAVAILABLE)
 *
 * English, in brackets, at the moment their money should have moved and their
 * basket has already been consumed into an order. So this translator exists
 * alongside the operator's rather than instead of it, and its contract is
 * different in one way that matters: **it never appends the code.** An
 * unrecognised failure falls back to a plain sentence, because a customer who
 * cannot act on a word should not be handed one.
 *
 * What each sentence has to do, and why they are not interchangeable: say
 * whether the order exists, say whether money moved, and say what to do next.
 * "خطایی رخ داد" answers none of those, which is why there is a map here at all.
 */
const CUSTOMER_MESSAGES: Readonly<Record<string, string>> = {
  /*
    No gateway is configured, or none is healthy. The order is real and unpaid,
    which is the part the customer most needs to know — otherwise they order
    again and we owe them two loads of bread.
  */
  PAYMENT_PROVIDER_UNAVAILABLE:
    'سفارش شما ثبت شد، ولی پرداخت آنلاین همین حالا در دسترس نیست. مبلغی از شما کم نشده. از بخش «سفارش‌های من» می‌توانید پرداخت را کمی بعد کامل کنید.',
  PAYMENT_PROVIDER_ADAPTER_UNAVAILABLE:
    'سفارش شما ثبت شد، ولی پرداخت آنلاین همین حالا در دسترس نیست. مبلغی از شما کم نشده. از بخش «سفارش‌های من» می‌توانید پرداخت را کمی بعد کامل کنید.',
  PROVIDER_CONFIGURATION_NOT_FOUND:
    'سفارش شما ثبت شد، ولی پرداخت آنلاین همین حالا در دسترس نیست. مبلغی از شما کم نشده. از بخش «سفارش‌های من» می‌توانید پرداخت را کمی بعد کامل کنید.',

  /*
    Two people, or two taps, on one order. Nothing is wrong and nothing is
    lost, so this says "look" rather than "try again" — a retry is how a
    customer ends up with two orders.
  */
  PAYMENT_PROVIDER_CONCURRENCY_CONFLICT:
    'این سفارش همین الان در حال پرداخت است. چند لحظه صبر کنید و وضعیت را در «سفارش‌های من» ببینید.',
  IDEMPOTENCY_KEY_CONFLICT:
    'این درخواست قبلاً ثبت شده است. وضعیت را در «سفارش‌های من» ببینید؛ دوباره پرداخت نکنید.',

  /* The basket moved under the quote. Re-pricing is the fix and it is safe. */
  QUOTE_EXPIRED: 'قیمت این سبد منقضی شد. دوباره «محاسبهٔ هزینه» را بزنید.',
  CART_VERSION_CONFLICT:
    'سبد شما از جای دیگری تغییر کرده است. صفحه را تازه کنید و دوباره قیمت بگیرید.',

  /* Money the customer does not have. Said as what to add, not what is missing. */
  INSUFFICIENT_WALLET_BALANCE:
    'موجودی کیف پول برای این سفارش کافی نیست. کیف پول را شارژ کنید یا از درگاه بانکی پرداخت کنید.',
}

/**
 * The sentence to show a customer for a refusal code.
 *
 * `fallback` is what to say when the code is not one we have words for — a
 * plain sentence the caller chose for that step, with nothing appended.
 */
export function customerErrorMessage(code: string, fallback: string): string {
  return CUSTOMER_MESSAGES[code] ?? fallback
}
