'use server'

import { revalidatePath } from 'next/cache'

import type { WalletTransferSummary, WalletWithdrawalSummary } from '@alo-noon/contracts'
import {
  formatToman,
  MINIMUM_WITHDRAWAL,
  parseTomanToRial,
  toLatinDigits,
  topUpRefusalMessage,
  transferRefusalMessage,
  validateTopUpAmount,
  validateTransferAmount,
  withdrawalRefusalMessage,
} from '@alo-noon/domain'

import { derivedIdempotencyKey, translateProviderError } from './admin-format'
import { normalizeMobile, normalizeOtpCode } from './shop-format'
import {
  confirmWalletTransfer,
  initializePayment,
  openWalletTransfer,
  requestWalletWithdrawal,
  startWalletTopUp,
} from './shop-api'

/**
 * The wallet's writes.
 *
 * Every amount that arrives here was typed by a person into a field labelled
 * Toman, and everything below this line is Rial. The conversion happens once,
 * at the edge, before anything is validated — a limit checked against the wrong
 * unit is a limit that is wrong by a factor of ten in whichever direction hurts
 * more.
 *
 * The domain's own validators run here as well as on the API. Not for safety —
 * the API is the authority and re-checks everything — but for the sentence:
 * a customer who typed a hundred Toman deserves to be told the minimum before a
 * round trip, in the same words the API would have used.
 */

export interface WalletFailure {
  ok: false
  message: string
  /** True when the same request could plausibly work if tried again. */
  retryable: boolean
}

export type TopUpResult = { ok: true; url: string } | WalletFailure
export type TransferOpenResult = { ok: true; transfer: WalletTransferSummary } | WalletFailure
export type TransferConfirmResult =
  { ok: true; transfer: WalletTransferSummary } | (WalletFailure & { attemptsLeft?: number })

function fail(message: string, retryable = false): WalletFailure {
  return { ok: false, message, retryable }
}

/**
 * Charges the balance through the bank.
 *
 * Opens a top-up payment and asks the gateway where to send the customer. It is
 * the same two calls an order's payment makes, because a top-up *is* an
 * ordinary payment — which is what buys it the callback route, the settlement
 * sweep and the retry semantics without writing any of them twice.
 *
 * Answers with a URL rather than redirecting, so the caller decides. A Server
 * Action that redirects cannot also report that the gateway refused.
 */
export async function topUpAction(amountToman: string): Promise<TopUpResult> {
  const amount = parseTomanToRial(amountToman)
  if (amount === null) return fail('مبلغ شارژ را درست وارد کنید.')

  const refusal = validateTopUpAmount(amount)
  if (refusal) return fail(topUpRefusalMessage(refusal))

  const started = await startWalletTopUp({
    amount: amount.toString(),
    // Derived from the amount and the hour, so a customer who double-taps gets
    // one top-up and one who genuinely wants a second charge an hour later gets
    // a second. A key derived from the amount alone would refuse the second.
    idempotencyKey: derivedIdempotencyKey('top-up', amount.toString(), hourStamp()),
  })
  if (!started.ok) {
    return fail(translateProviderError(started.error.code, 'شارژ کیف پول باز نشد.'), true)
  }

  const execution = await initializePayment({
    paymentId: started.data.paymentId,
    idempotencyKey: derivedIdempotencyKey('initialize', started.data.paymentId),
  })
  if (!execution.ok) {
    return fail(translateProviderError(execution.error.code, 'اتصال به درگاه برقرار نشد.'), true)
  }

  const url = execution.data.customerAction?.url
  if (execution.data.state === 'CUSTOMER_ACTION_REQUIRED' && url) {
    revalidatePath('/wallet')
    return { ok: true, url }
  }

  // The gateway answered without sending the customer anywhere. Its own code
  // says more than "payment failed" would.
  return fail(
    execution.data.failure
      ? translateProviderError(execution.data.failure.code, 'درگاه پرداخت را نپذیرفت.')
      : 'درگاه پرداخت در دسترس نیست. کمی بعد دوباره تلاش کنید.',
    true,
  )
}

/**
 * Names a recipient and an amount, and asks for the code.
 *
 * Nothing moves here. The refusals are the interesting part: a number nobody
 * has registered, the sender's own number, an amount out of range, or a balance
 * that does not cover it — each one a different sentence, because each one has
 * a different fix.
 */
export async function openTransferAction(input: {
  recipientMobile: string
  amountToman: string
}): Promise<TransferOpenResult> {
  const recipientMobile = normalizeMobile(input.recipientMobile)
  if (!recipientMobile) return fail('شمارهٔ گیرنده معتبر نیست.')

  const amount = parseTomanToRial(input.amountToman)
  if (amount === null) return fail('مبلغ انتقال را درست وارد کنید.')

  const refusal = validateTransferAmount(amount)
  if (refusal) return fail(transferRefusalMessage(refusal) ?? 'مبلغ انتقال معتبر نیست.')

  const opened = await openWalletTransfer({
    recipientMobile,
    amount: amount.toString(),
    idempotencyKey: derivedIdempotencyKey(
      'transfer',
      recipientMobile,
      amount.toString(),
      hourStamp(),
    ),
  })
  if (!opened.ok) {
    const shortfall = shortfallFrom(opened.error.details)
    if (shortfall) {
      return fail(`موجودی کافی نیست. ${shortfall} کم دارید.`)
    }
    return fail(
      transferRefusalMessage(opened.error.code) ?? opened.error.message,
      opened.error.code === 'CODE_NOT_SENT',
    )
  }

  revalidatePath('/wallet')
  return { ok: true, transfer: opened.data }
}

/** Types the code back. This is the call that moves the money. */
export async function confirmTransferAction(
  transferId: string,
  code: string,
): Promise<TransferConfirmResult> {
  const normalized = normalizeOtpCode(code)
  if (normalized.length < 4) return fail('کد تأیید را کامل وارد کنید.')

  const confirmed = await confirmWalletTransfer(transferId, normalized)
  if (!confirmed.ok) {
    const attemptsLeft = attemptsFrom(confirmed.error.details)
    return {
      ...fail(confirmed.error.message, confirmed.error.code === 'INVALID_CODE'),
      ...(attemptsLeft !== null && { attemptsLeft }),
    }
  }

  revalidatePath('/wallet')
  return { ok: true, transfer: confirmed.data }
}

/** The Toman phrase inside a refusal's `details.shortfall`, when there is one. */
function shortfallFrom(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null
  const shortfall = (details as Record<string, unknown>)['shortfall']
  if (!shortfall || typeof shortfall !== 'object') return null
  const amount = (shortfall as { amount?: unknown }).amount
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null
  try {
    return formatToman(BigInt(amount))
  } catch {
    return null
  }
}

function attemptsFrom(details: unknown): number | null {
  if (!details || typeof details !== 'object') return null
  const left = (details as Record<string, unknown>)['attemptsLeft']
  return typeof left === 'number' && Number.isInteger(left) && left >= 0 ? left : null
}

/**
 * The current hour, as the part of an idempotency key that lets a customer
 * repeat themselves deliberately.
 *
 * Keyed on the amount alone, a customer who charged fifty thousand this morning
 * and wants another fifty thousand tonight would silently replay the first.
 * Keyed on nothing, a double-tap charges twice. An hour is long enough to cover
 * a retry and short enough to cover a change of mind.
 */
function hourStamp(): string {
  return new Date().toISOString().slice(0, 13)
}

export type WithdrawalResult = { ok: true; withdrawal: WalletWithdrawalSummary } | WalletFailure

/**
 * Asking for the balance back, in money.
 *
 * The card number is typed here and never comes back: the API keeps four digits
 * and forgets the rest before the row is written. Nothing on this side stores
 * it, logs it, or puts it in an idempotency key — a key is a value that survives
 * in the database, and a card number that survives anywhere is the one mistake
 * this whole flow cannot afford.
 *
 * Keyed on the amount and the hour rather than on a random value: a
 * double-submitted form replays onto the request it already made, while a
 * customer who deliberately asks for a second withdrawal later in the day gets
 * a second one.
 */
export async function requestWithdrawalAction(input: {
  amountToman: string
  cardNumber: string
  cardHolderName: string
  iban?: string
}): Promise<WithdrawalResult> {
  const amount = parseTomanToRial(input.amountToman)
  if (amount === null) return fail('مبلغ برداشت را درست وارد کنید.')
  if (amount < MINIMUM_WITHDRAWAL) {
    return fail(withdrawalRefusalMessage('BELOW_MINIMUM'))
  }

  // Digits only, and exactly sixteen. Iranian debit cards are printed in groups
  // of four, so a customer pasting one arrives with spaces or dashes and should
  // not be told their own card is invalid.
  const cardNumber = toLatinDigits(input.cardNumber).replace(/\D/g, '')
  if (!/^\d{16}$/.test(cardNumber)) return fail('شمارهٔ کارت باید ۱۶ رقم باشد.')

  const holder = input.cardHolderName.trim()
  if (holder.length < 2) return fail('نام صاحب کارت را وارد کنید.')

  const iban = input.iban ? toLatinDigits(input.iban).replace(/[\s-]/g, '').toUpperCase() : ''
  if (iban && !/^IR\d{24}$/.test(iban)) return fail('شبا باید با IR و ۲۴ رقم باشد.')

  const result = await requestWalletWithdrawal({
    amount: amount.toString(),
    cardNumber,
    cardHolderName: holder,
    ...(iban && { iban }),
    // The card is deliberately absent from the key: it would put the number in
    // a column that is kept forever.
    idempotencyKey: derivedIdempotencyKey('withdrawal', amount.toString(), hourStamp()),
  })
  if (!result.ok) {
    return fail(
      translateProviderError(result.error.code, result.error.message),
      result.error.code === 'WITHDRAWAL_UNAVAILABLE',
    )
  }
  revalidatePath('/wallet')
  return { ok: true, withdrawal: result.data }
}
