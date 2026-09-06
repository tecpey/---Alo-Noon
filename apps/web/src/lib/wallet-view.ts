import type { WalletEntrySummary, WalletTransferSummary } from '@alo-noon/contracts'

/**
 * What a statement line says, and which way it points.
 *
 * A balance history is the one screen where a customer checks arithmetic they
 * did not do. Every line has to answer three questions without being read
 * twice: what happened, did money come in or go out, and what was left. Getting
 * the direction wrong is worse than showing nothing — it makes the running
 * total look like a mistake and the platform look like it lost the money.
 */
export type WalletDirection = 'IN' | 'OUT'

const ENTRY_KINDS: Readonly<
  Record<WalletEntrySummary['kind'], { label: string; direction: WalletDirection }>
> = {
  TOP_UP: { label: 'شارژ کیف پول', direction: 'IN' },
  ORDER_PAYMENT: { label: 'پرداخت سفارش', direction: 'OUT' },
  REFUND: { label: 'بازگشت وجه سفارش', direction: 'IN' },
  TRANSFER_IN: { label: 'دریافت از کیف پول دیگر', direction: 'IN' },
  TRANSFER_OUT: { label: 'انتقال به کیف پول دیگر', direction: 'OUT' },
}

export function walletEntryLabel(kind: WalletEntrySummary['kind']): string {
  return ENTRY_KINDS[kind].label
}

export function walletEntryDirection(kind: WalletEntrySummary['kind']): WalletDirection {
  return ENTRY_KINDS[kind].direction
}

/**
 * The sign a customer reads before they read the number.
 *
 * A plus and a minus rather than colour alone: colour is the first thing a
 * screenshot, a colour-blind reader and a bright morning all lose.
 */
export function walletEntrySign(kind: WalletEntrySummary['kind']): '+' | '−' {
  return walletEntryDirection(kind) === 'IN' ? '+' : '−'
}

const TRANSFER_STATES: Readonly<Record<WalletTransferSummary['state'], string>> = {
  PENDING: 'در انتظار کد تأیید',
  COMPLETED: 'انجام شد',
  EXPIRED: 'منقضی شد',
  CANCELLED: 'لغو شد',
}

export function transferStateLabel(state: WalletTransferSummary['state']): string {
  return TRANSFER_STATES[state]
}

/**
 * The amounts offered as one tap, in Toman.
 *
 * Round numbers a person would actually pick, spanning about one order to about
 * a month of them. The list exists so the common case is a tap rather than
 * typing: a keypad on a phone is where a customer meant to add fifty thousand
 * and added five hundred thousand.
 */
export const TOP_UP_PRESETS_TOMAN = Object.freeze([50_000, 100_000, 200_000, 500_000])

/**
 * How much more is needed, phrased for the button that fixes it.
 *
 * Rounded *up* to the nearest ten thousand Toman, never down. A suggestion that
 * lands one Toman short is a second trip to a bank gateway, which is the whole
 * thing the suggestion exists to avoid.
 */
export function suggestedTopUpRial(shortfallRial: bigint): bigint {
  const step = 100_000n
  if (shortfallRial <= 0n) return step
  const remainder = shortfallRial % step
  return remainder === 0n ? shortfallRial : shortfallRial + (step - remainder)
}

/** True when the balance covers the total, both as Rial digit strings. */
export function balanceCovers(balanceRial: string, totalRial: string): boolean {
  if (!/^\d+$/.test(balanceRial) || !/^\d+$/.test(totalRial)) return false
  return BigInt(balanceRial) >= BigInt(totalRial)
}

/** What is missing, or null when nothing is. */
export function shortfallRial(balanceRial: string, totalRial: string): bigint | null {
  if (!/^\d+$/.test(balanceRial) || !/^\d+$/.test(totalRial)) return null
  const missing = BigInt(totalRial) - BigInt(balanceRial)
  return missing > 0n ? missing : null
}
