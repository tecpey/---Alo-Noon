import { DomainError } from './errors'
import type { ActorId, AggregateId, CorrelationId, EventId } from './ids'

export const DomainEventName = {
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_ADDRESS_ADDED: 'customer.address_added',
  CUSTOMER_PREFERENCE_UPDATED: 'customer.preference_updated',
  PRODUCT_VIEWED: 'product.viewed',
  PRODUCT_ADDED_TO_CART: 'product.added_to_cart',
  ORDER_CREATED: 'order.created',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_DELIVERED: 'order.delivered',
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_STATE_CHANGED: 'payment.state_changed',
  FINANCIAL_TRANSACTION_POSTED: 'financial.transaction_posted',
  SUPPORT_CASE_CREATED: 'support.case_created',
} as const
export type DomainEventName = (typeof DomainEventName)[keyof typeof DomainEventName]

export const EventPurpose = {
  DOMAIN: 'DOMAIN',
  AUDIT: 'AUDIT',
  ENGAGEMENT: 'ENGAGEMENT',
} as const
export type EventPurpose = (typeof EventPurpose)[keyof typeof EventPurpose]

export const ConsentBasis = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  TRANSACTIONAL: 'TRANSACTIONAL',
  EXPLICIT_CONSENT: 'EXPLICIT_CONSENT',
} as const
export type ConsentBasis = (typeof ConsentBasis)[keyof typeof ConsentBasis]

export interface EventActor {
  type: 'CUSTOMER' | 'STAFF' | 'BAKERY' | 'COURIER' | 'SYSTEM'
  id?: ActorId
}

export interface DomainEventEnvelope<Payload extends Readonly<Record<string, unknown>>> {
  eventId: EventId
  name: DomainEventName
  version: 1
  purpose: EventPurpose
  occurredAt: Date
  actor: EventActor
  subject: { type: string; id: AggregateId }
  correlationId: CorrelationId
  causationId?: EventId
  consentBasis: ConsentBasis
  payload: Payload
}

export function defineDomainEvent<Payload extends Readonly<Record<string, unknown>>>(
  event: DomainEventEnvelope<Payload>,
): Readonly<DomainEventEnvelope<Payload>> {
  const issues: string[] = []
  if (event.version !== 1) issues.push('Only event envelope version 1 is supported')
  if (Number.isNaN(event.occurredAt.getTime())) issues.push('occurredAt must be a valid timestamp')
  if (event.actor.type !== 'SYSTEM' && !event.actor.id) {
    issues.push('Non-system actors require an actor ID')
  }
  if (
    event.purpose === EventPurpose.ENGAGEMENT &&
    event.consentBasis === ConsentBasis.NOT_REQUIRED
  ) {
    issues.push('Engagement events require a transactional or explicit consent basis')
  }
  if (Object.keys(event.payload).some((key) => /phone|address|email|name/i.test(key))) {
    issues.push(
      'Event payload keys must not embed direct PII; reference server-side entities instead',
    )
  }
  if (issues.length > 0) {
    throw new DomainError('INVALID_EVENT_ENVELOPE', 'Domain event envelope is invalid', { issues })
  }
  return Object.freeze(event)
}
