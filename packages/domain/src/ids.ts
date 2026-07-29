declare const brand: unique symbol

export type Brand<T, Name extends string> = T & { readonly [brand]: Name }

export type AggregateId = Brand<string, 'AggregateId'>
export type ActorId = Brand<string, 'ActorId'>
export type CorrelationId = Brand<string, 'CorrelationId'>
export type EventId = Brand<string, 'EventId'>
export type OrderId = Brand<string, 'OrderId'>

export function asAggregateId(value: string): AggregateId {
  return assertIdentifier(value, 'AggregateId')
}

export function asActorId(value: string): ActorId {
  return assertIdentifier(value, 'ActorId')
}

export function asCorrelationId(value: string): CorrelationId {
  return assertIdentifier(value, 'CorrelationId')
}

export function asEventId(value: string): EventId {
  return assertIdentifier(value, 'EventId')
}

export function asOrderId(value: string): OrderId {
  return assertIdentifier(value, 'OrderId')
}

function assertIdentifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  const normalized = value.trim()
  if (normalized.length < 8 || normalized.length > 128) {
    throw new TypeError(`${name} must contain between 8 and 128 characters`)
  }
  return normalized as Brand<string, Name>
}
