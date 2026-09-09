import { DomainError } from './errors'
import { formatToman } from './toman'

/**
 * Sending part of a balance to somebody else's.
 *
 * This is the one movement where a customer's money leaves their reach without
 * anything arriving for them, and where the beneficiary is chosen by typing a
 * phone number. Both facts shape everything here.
 *
 * The phone number means a mistake is silent: 0912 and 0913 differ by one key,
 * and the money lands in a real stranger's balance rather than bouncing. So the
 * sender is shown who they are about to pay and has to confirm with a code sent
 * to their own handset. The code is not proof of identity — the session already
 * proved that — it is a second, deliberate act, and the thing that makes a
 * stolen unlocked phone or a hijacked session unable to empty a balance
 * quietly.
 *
 * Nothing is held in escrow while a transfer waits for its code. Moving the
 * money early and putting it back on expiry would invent a balance that is
 * neither the sender's nor the recipient's, visible in neither statement. The
 * balance is checked again at confirmation instead, which is the only moment
 * the answer has to be true.
 */
export const WalletTransferState = {
  /** Created, code sent, waiting for the sender to type it back. */
  PENDING: 'PENDING',
  /** Confirmed and moved. Terminal. */
  COMPLETED: 'COMPLETED',
  /** The code ran out of time or attempts. Terminal, and nothing moved. */
  EXPIRED: 'EXPIRED',
  /** The sender changed their mind. Terminal, and nothing moved. */
  CANCELLED: 'CANCELLED',
} as const
export type WalletTransferState = (typeof WalletTransferState)[keyof typeof WalletTransferState]

/**
 * How long a code is good for.
 *
 * Long enough to walk out of a basement and receive a text, short enough that a
 * code read off a lock screen hours later is useless.
 */
export const TRANSFER_CODE_TTL_MS = 5 * 60 * 1000

/**
 * Wrong codes before a transfer is dead.
 *
 * Six digits is a million possibilities; five guesses makes brute force
 * pointless without making a fat-fingered customer start over.
 */
export const TRANSFER_MAX_ATTEMPTS = 5

/**
 * What may be sent in one transfer.
 *
 * The floor is a nuisance filter rather than an economic one — a transfer costs
 * the platform an SMS, and a hundred one-Rial sends is somebody testing what
 * happens. The ceiling is the amount a compromised session can move before a
 * human notices, deliberately lower than the top-up ceiling: charging your own
 * balance is recoverable, sending it to a stranger is not.
 */
export const MINIMUM_TRANSFER = 10_000n
export const MAXIMUM_TRANSFER = 20_000_000n

export type TransferRefusal =
  'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'NOT_A_WHOLE_RIAL' | 'SELF_TRANSFER'

export function validateTransferAmount(amount: bigint): TransferRefusal | undefined {
  if (amount <= 0n || amount % 1n !== 0n) return 'NOT_A_WHOLE_RIAL'
  if (amount < MINIMUM_TRANSFER) return 'BELOW_MINIMUM'
  if (amount > MAXIMUM_TRANSFER) return 'ABOVE_MAXIMUM'
  return undefined
}

/**
 * In Toman, like every price on the site. The ledger keeps Rial and nobody says
 * Rial out loud; a limit quoted in the wrong unit is off by a factor of ten.
 */
const REFUSAL_MESSAGES: Readonly<Record<TransferRefusal, string>> = {
  NOT_A_WHOLE_RIAL: 'مبلغ انتقال معتبر نیست.',
  BELOW_MINIMUM: `کمترین مبلغ انتقال ${formatToman(MINIMUM_TRANSFER)} است.`,
  ABOVE_MAXIMUM: `بیشترین مبلغ انتقال در هر بار ${formatToman(MAXIMUM_TRANSFER)} است.`,
  SELF_TRANSFER: 'نمی‌توانید به کیف پول خودتان انتقال دهید.',
}

export function transferRefusalMessage(reason: string): string | undefined {
  return REFUSAL_MESSAGES[reason as TransferRefusal]
}

/**
 * What a confirmation attempt means.
 *
 * Returned rather than thrown, and deliberately coarse on the outside: a
 * customer is told the code is wrong or expired, never which. Telling them
 * "expired" separately from "wrong" tells an attacker holding a stolen phone
 * whether they are racing a clock or a keyspace.
 *
 * `EXHAUSTED` is separate because it is the one refusal that is final — the
 * transfer is dead and the sender has to start again — and a customer who is
 * not told that will keep typing.
 */
export type TransferConfirmation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'INVALID_CODE'; readonly attemptsLeft: number }
  | { readonly ok: false; readonly reason: 'EXHAUSTED' }
  | { readonly ok: false; readonly reason: 'NOT_PENDING' }

export function evaluateTransferConfirmation(input: {
  readonly state: WalletTransferState
  readonly expiresAt: Date
  readonly failedAttempts: number
  readonly codeMatches: boolean
  readonly now: Date
}): TransferConfirmation {
  if (input.state !== WalletTransferState.PENDING) {
    return { ok: false, reason: 'NOT_PENDING' }
  }
  // Expiry and exhaustion are the same answer to the customer and the same
  // answer to the transfer: it is over, start again.
  if (input.now.getTime() >= input.expiresAt.getTime()) {
    return { ok: false, reason: 'EXHAUSTED' }
  }
  if (input.failedAttempts >= TRANSFER_MAX_ATTEMPTS) {
    return { ok: false, reason: 'EXHAUSTED' }
  }
  if (input.codeMatches) return { ok: true }

  const attemptsLeft = TRANSFER_MAX_ATTEMPTS - (input.failedAttempts + 1)
  if (attemptsLeft <= 0) return { ok: false, reason: 'EXHAUSTED' }
  return { ok: false, reason: 'INVALID_CODE', attemptsLeft }
}

/**
 * A phone number as the sender sees it back.
 *
 * Enough to recognise a number they meant to type and to catch one they did
 * not, without printing a stranger's full number on a screen the sender does
 * not own. The last four digits are the ones people check.
 */
export function maskMobile(mobileE164: string): string {
  const digits = mobileE164.replace(/\D/g, '')
  if (digits.length < 4) {
    throw new DomainError('INVALID_WALLET_TRANSFER', 'A mobile number cannot be masked')
  }
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

/**
 * A name as the sender sees it back.
 *
 * The point is recognition, not disclosure: somebody who types a wrong number
 * should see enough to know it is not the person they meant, and not enough to
 * learn who a stranger is. A first name and an initial does that; a full name
 * turns a phone keypad into a directory lookup.
 */
export function maskName(name: string | null | undefined): string | undefined {
  const trimmed = name?.trim()
  if (!trimmed) return undefined
  const [first, ...rest] = trimmed.split(/\s+/)
  if (!first) return undefined
  const last = rest.at(-1)
  return last ? `${first} ${last.slice(0, 1)}.` : first
}
