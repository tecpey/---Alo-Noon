export type DomainErrorCode =
  | 'CURRENCY_MISMATCH'
  | 'INVALID_MONEY_AMOUNT'
  | 'INVALID_PRODUCT_CLASSIFICATION'
  | 'INVALID_ORDER_TRANSITION'
  | 'UNAUTHORIZED_ORDER_TRANSITION'
  | 'INVALID_EVENT_ENVELOPE'

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
