import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import { ConsentBasis, DomainEventName, EventPurpose, defineDomainEvent } from './events'
import { asActorId, asAggregateId, asCorrelationId, asEventId } from './ids'

const baseEvent = {
  eventId: asEventId('event_12345678'),
  name: DomainEventName.ORDER_CREATED,
  version: 1 as const,
  purpose: EventPurpose.DOMAIN,
  occurredAt: new Date('2026-07-25T08:30:00.000Z'),
  actor: { type: 'CUSTOMER' as const, id: asActorId('customer_12345678') },
  subject: { type: 'order', id: asAggregateId('order_12345678') },
  correlationId: asCorrelationId('correlation_12345678'),
  consentBasis: ConsentBasis.TRANSACTIONAL,
}

describe('domain event envelope', () => {
  it('accepts a versioned, correlated, PII-minimized event', () => {
    const event = defineDomainEvent({ ...baseEvent, payload: { orderState: 'DRAFT' } })
    expect(event.name).toBe('order.created')
  })

  it('rejects direct PII in payloads and consent-free engagement events', () => {
    expect(() =>
      defineDomainEvent({ ...baseEvent, payload: { phone: '+981234567890' } }),
    ).toThrowError(DomainError)
    expect(() =>
      defineDomainEvent({
        ...baseEvent,
        purpose: EventPurpose.ENGAGEMENT,
        consentBasis: ConsentBasis.NOT_REQUIRED,
        payload: { productId: 'product_123' },
      }),
    ).toThrowError(DomainError)
  })
})
