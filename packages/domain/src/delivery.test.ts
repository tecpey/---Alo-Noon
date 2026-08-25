import { describe, expect, it } from 'vitest'

import {
  courierCanBeOffered,
  deliveryTaskIsTerminal,
  orderDeliveryStateFor,
  transitionDeliveryAssignment,
  transitionDeliveryTask,
  DeliveryTaskState,
} from './delivery'
import type { TransitionActor } from './order'

const move = (from: DeliveryTaskState, to: DeliveryTaskState, actor: TransitionActor) =>
  transitionDeliveryTask({ from, to, actor })

describe('delivery task transitions', () => {
  it('walks a delivery from offer to doorstep', () => {
    expect(move('UNASSIGNED', 'ASSIGNMENT_PENDING', 'STAFF')).toBeTruthy()
    expect(move('ASSIGNMENT_PENDING', 'ASSIGNED', 'COURIER')).toBeTruthy()
    expect(move('ASSIGNED', 'PICKED_UP', 'COURIER')).toBeTruthy()
    expect(move('PICKED_UP', 'OUT_FOR_DELIVERY', 'COURIER')).toBeTruthy()
    expect(move('OUT_FOR_DELIVERY', 'DELIVERED', 'COURIER')).toBeTruthy()
  })

  it('keeps a dispatcher out of the courier job', () => {
    // Only the person holding the bag knows whether it was picked up or handed
    // over. A dispatcher asserting either could close an order for bread still
    // sitting on a shelf.
    for (const to of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED'] as const) {
      expect(() => move(previousOf(to), to, 'STAFF')).toThrow(/cannot move a delivery/)
    }
  })

  it('keeps a courier out of the dispatcher job', () => {
    // Dropping work is a conversation, not a button: a task silently returned
    // to the pool at the moment it was due is how an order goes quiet.
    expect(() => move('ASSIGNED', 'UNASSIGNED', 'COURIER')).toThrow(/cannot move a delivery/)
    expect(() => move('UNASSIGNED', 'ASSIGNMENT_PENDING', 'COURIER')).toThrow(
      /cannot move a delivery/,
    )
  })

  it('returns a refused offer to the pool rather than ending the delivery', () => {
    // One courier saying no is not the delivery failing. The order is still
    // owed to someone.
    expect(move('ASSIGNMENT_PENDING', 'UNASSIGNED', 'STAFF')).toBeTruthy()
    expect(deliveryTaskIsTerminal('UNASSIGNED')).toBe(false)
  })

  it('lets a failed delivery be tried again', () => {
    // Nobody home at four is a reason to try at six, not a reason to keep the
    // customer's money and their bread.
    expect(move('FAILED', 'UNASSIGNED', 'STAFF')).toBeTruthy()
    expect(deliveryTaskIsTerminal('FAILED')).toBe(false)
  })

  it('treats delivered and cancelled as the end', () => {
    expect(deliveryTaskIsTerminal('DELIVERED')).toBe(true)
    expect(deliveryTaskIsTerminal('CANCELLED')).toBe(true)
    expect(() => move('DELIVERED', 'FAILED', 'COURIER')).toThrow(/cannot move from DELIVERED/)
    expect(() => move('CANCELLED', 'UNASSIGNED', 'STAFF')).toThrow(/cannot move from CANCELLED/)
  })

  it('refuses to skip the middle of a route', () => {
    expect(() => move('ASSIGNED', 'DELIVERED', 'COURIER')).toThrow(/cannot move from ASSIGNED/)
    expect(() => move('UNASSIGNED', 'PICKED_UP', 'COURIER')).toThrow(/cannot move from UNASSIGNED/)
  })

  it('refuses a step to where it already is', () => {
    expect(() => move('ASSIGNED', 'ASSIGNED', 'COURIER')).toThrow(/already in that state/)
  })

  it('lets a cancelled order reach its delivery without a person', () => {
    expect(
      transitionDeliveryTask({ from: 'ASSIGNED', to: 'CANCELLED', actor: 'SYSTEM' }),
    ).toBeTruthy()
  })
})

describe('assignment transitions', () => {
  it('lets a courier answer an offer either way', () => {
    for (const to of ['ACCEPTED', 'REJECTED'] as const) {
      expect(transitionDeliveryAssignment({ from: 'OFFERED', to, actor: 'COURIER' })).toBeTruthy()
    }
  })

  it('does not let a courier answer for someone else by completing an offer', () => {
    expect(() =>
      transitionDeliveryAssignment({ from: 'ACCEPTED', to: 'COMPLETED', actor: 'COURIER' }),
    ).toThrow(/cannot move an assignment/)
  })

  it('refuses to revive an answered offer', () => {
    for (const from of ['REJECTED', 'CANCELLED', 'COMPLETED'] as const) {
      expect(() =>
        transitionDeliveryAssignment({ from, to: 'ACCEPTED', actor: 'COURIER' }),
      ).toThrow(/cannot move from/)
    }
  })
})

describe('what the order says', () => {
  it('does not promise a customer a courier who has not answered yet', () => {
    // An offer nobody has accepted is not an assignment, and saying otherwise
    // makes a promise on the courier's behalf.
    expect(orderDeliveryStateFor('ASSIGNMENT_PENDING')).toBe('UNASSIGNED')
    expect(orderDeliveryStateFor('ASSIGNED')).toBe('ASSIGNED')
  })

  it('maps every task state to something an order can say', () => {
    for (const state of Object.values(DeliveryTaskState)) {
      expect(typeof orderDeliveryStateFor(state)).toBe('string')
    }
  })
})

describe('who can be offered work', () => {
  it('offers only a courier who is actually working', () => {
    expect(courierCanBeOffered('AVAILABLE')).toBe(true)
    // Onboarding is not finished, and unavailable means they said they are not
    // working. Either one is an order that sits.
    for (const status of ['ONBOARDING', 'UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED']) {
      expect(courierCanBeOffered(status)).toBe(false)
    }
  })
})

/** The state a task must be in for `to` to be a legal next step. */
function previousOf(to: DeliveryTaskState): DeliveryTaskState {
  switch (to) {
    case 'PICKED_UP':
      return 'ASSIGNED'
    case 'OUT_FOR_DELIVERY':
      return 'PICKED_UP'
    case 'DELIVERED':
      return 'OUT_FOR_DELIVERY'
    default:
      return 'OUT_FOR_DELIVERY'
  }
}
