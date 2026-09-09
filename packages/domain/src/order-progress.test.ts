import { describe, expect, it } from 'vitest'

import { orderProgress } from './order-progress'

const base = {
  state: 'CONFIRMED',
  paymentState: 'NOT_STARTED',
  productionState: 'UNSCHEDULED',
  deliveryState: 'UNASSIGNED',
}

describe('what a customer is told about their order', () => {
  it('says the thing that went wrong before the thing that is going right', () => {
    // An order can be cancelled and still carry a production state from before
    // it was. Reporting "در حال پخت" for a cancelled order is how a customer
    // waits all evening for bread nobody is baking.
    expect(
      orderProgress({ ...base, state: 'CANCELLED', productionState: 'IN_PRODUCTION' }).tone,
    ).toBe('bad')
  })

  it('puts a refund ahead of the delivery it belongs to', () => {
    expect(orderProgress({ ...base, paymentState: 'REFUNDED' }).headline).toContain('بازگردانده')
  })

  it('reports an unpaid order as the customer’s move', () => {
    expect(orderProgress(base).headline).toBe('در انتظار پرداخت')
  })

  it('follows the bread once it is out of the bakery', () => {
    expect(
      orderProgress({ ...base, paymentState: 'PAID', deliveryState: 'OUT_FOR_DELIVERY' }),
    ).toMatchObject({ tone: 'live', step: 4 })
  })

  it('ends only when it actually arrived', () => {
    expect(orderProgress({ ...base, state: 'COMPLETED', deliveryState: 'DELIVERED' }).tone).toBe(
      'done',
    )
  })

  it('never reports a failed delivery as finished', () => {
    const failed = orderProgress({ ...base, state: 'DELIVERY_FAILED', deliveryState: 'FAILED' })
    expect(failed.tone).toBe('bad')
  })
})
