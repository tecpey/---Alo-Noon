import { z } from 'zod'

import { isoDateTimeSchema, moneySchema, uuidSchema } from './common'

/**
 * What the platform owes its partners, and the runs that discharge it.
 *
 * A delivered order stops being the platform's money and becomes two debts: the
 * bakery's share of what the customer paid, and the courier partner's share of
 * the delivery fee. This transport carries those debts to whoever pays them and
 * carries the payout back.
 *
 * Every amount is IRR minor units as a decimal string. A month of one city's
 * bakery payables passes what a JSON number holds exactly, and a payout that
 * rounds is a payout somebody has to argue about.
 */
export const settlementPartySchema = z.enum(['BAKERY', 'COURIER'])
export type SettlementParty = z.infer<typeof settlementPartySchema>

export const partnerBalanceSchema = z.object({
  party: settlementPartySchema,
  partnerId: uuidSchema,
  partnerName: z.string().min(1),
  amount: moneySchema,
  orderCount: z.number().int().min(0),
  /**
   * When the oldest unpaid order was delivered. This is the number that says a
   * partner is being made to wait, which a total alone never shows: two partners
   * owed the same amount are in very different positions if one has been waiting
   * since last month.
   */
  oldestAt: isoDateTimeSchema.nullable(),
})
export type PartnerBalance = z.infer<typeof partnerBalanceSchema>

export const partnerPayoutStateSchema = z.enum(['DRAFT', 'PAID', 'CANCELLED'])

export const partnerPayoutSummarySchema = z.object({
  id: uuidSchema,
  party: settlementPartySchema,
  partnerId: uuidSchema,
  partnerName: z.string().min(1),
  state: partnerPayoutStateSchema,
  amount: moneySchema,
  orderCount: z.number().int().min(1),
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  /** What the bank called the transfer. Present once somebody sent the money. */
  bankReference: z.string().min(1).max(128).optional(),
  createdAt: isoDateTimeSchema,
  paidAt: isoDateTimeSchema.optional(),
})
export type PartnerPayoutSummary = z.infer<typeof partnerPayoutSummarySchema>

/**
 * Preparing a run.
 *
 * The amount is never in the request: it is whatever the partner has earned and
 * not been paid at the instant the transaction reads it. A staff-supplied figure
 * would be a staff-chosen payout, and the one thing a payout must not be is a
 * number somebody typed.
 */
export const preparePayoutCommandSchema = z
  .object({
    party: settlementPartySchema,
    partnerId: uuidSchema,
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict()
export type PreparePayoutCommand = z.infer<typeof preparePayoutCommandSchema>

export const markPayoutPaidCommandSchema = z
  .object({
    /**
     * The bank's own reference for the transfer. Required, because a payout
     * marked paid with nothing to look it up by cannot be reconciled against a
     * statement, and reconciling against a statement is the entire point of
     * recording it.
     */
    bankReference: z.string().min(1).max(128),
  })
  .strict()
export type MarkPayoutPaidCommand = z.infer<typeof markPayoutPaidCommandSchema>

export const payoutListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict()
export type PayoutListQuery = z.infer<typeof payoutListQuerySchema>
