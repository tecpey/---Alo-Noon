/**
 * How an order's four states read to the customer who placed it.
 *
 * Lives in the domain rather than in one app because both the site and the
 * phone show it, and a repository rule forbids one application importing
 * another. The alternative — a copy in each — is the version where the web says
 * "در حال پخت" and the app says something slightly different about the same
 * order, and nobody notices until a customer reads both.
 *
 * The system tracks order, payment, production and delivery separately, which is
 * right — an order can be paid and unbaked, or baked and undelivered — but a
 * customer does not want four status badges. They want one sentence about where
 * their bread is, and the detail underneath if they go looking.
 *
 * The order of these checks is the order that matters to a person: something
 * that went wrong first, then something on its way, then something waiting.
 */
export interface OrderStates {
  state: string
  paymentState: string
  productionState: string
  deliveryState: string
}

export interface OrderProgress {
  /** One line. What a customer would tell somebody else about this order. */
  headline: string
  /** `bad` needs attention, `live` is in motion, `done` has arrived. */
  tone: 'bad' | 'live' | 'waiting' | 'done'
  /** How far along, for the step rail. Zero when the order never started. */
  step: number
  steps: readonly string[]
}

export const ORDER_STEPS = ['ثبت سفارش', 'پرداخت', 'آماده‌سازی', 'تحویل'] as const

export function orderProgress(order: OrderStates): OrderProgress {
  const steps = ORDER_STEPS

  if (order.state === 'CANCELLED') {
    return { headline: 'این سفارش لغو شد', tone: 'bad', step: 0, steps }
  }
  if (order.state === 'CANCEL_REQUESTED') {
    return { headline: 'درخواست لغو در حال بررسی است', tone: 'bad', step: 1, steps }
  }
  if (order.paymentState === 'REFUNDED') {
    return { headline: 'مبلغ این سفارش بازگردانده شد', tone: 'bad', step: 0, steps }
  }
  if (order.paymentState === 'REFUND_PENDING') {
    return { headline: 'بازگشت وجه در جریان است', tone: 'bad', step: 1, steps }
  }
  if (order.deliveryState === 'FAILED' || order.state === 'DELIVERY_FAILED') {
    return { headline: 'تحویل انجام نشد؛ پشتیبانی پیگیری می‌کند', tone: 'bad', step: 3, steps }
  }

  if (order.deliveryState === 'DELIVERED' || order.state === 'COMPLETED') {
    return { headline: 'تحویل داده شد', tone: 'done', step: 4, steps }
  }
  if (order.deliveryState === 'OUT_FOR_DELIVERY') {
    return { headline: 'پیک در راه است', tone: 'live', step: 4, steps }
  }
  if (order.deliveryState === 'PICKED_UP') {
    return { headline: 'نان از نانوایی تحویل پیک شد', tone: 'live', step: 4, steps }
  }
  if (order.deliveryState === 'ASSIGNED') {
    return { headline: 'پیک تعیین شد', tone: 'live', step: 3, steps }
  }
  if (order.productionState === 'READY' || order.productionState === 'HANDED_OFF') {
    return { headline: 'نان آمادهٔ ارسال است', tone: 'live', step: 3, steps }
  }
  if (order.productionState === 'IN_PRODUCTION') {
    return { headline: 'در حال پخت', tone: 'live', step: 3, steps }
  }
  if (order.productionState === 'SCHEDULED') {
    return { headline: 'برای پخت زمان‌بندی شد', tone: 'waiting', step: 3, steps }
  }

  if (order.paymentState === 'PAID') {
    return { headline: 'پرداخت شد؛ در نوبت آماده‌سازی', tone: 'waiting', step: 2, steps }
  }
  if (order.paymentState === 'PENDING') {
    return { headline: 'پرداخت در حال بررسی است', tone: 'waiting', step: 2, steps }
  }
  // A placed order that was never paid. Said plainly, because it is the one
  // state where the customer has something to do.
  return { headline: 'در انتظار پرداخت', tone: 'waiting', step: 1, steps }
}
