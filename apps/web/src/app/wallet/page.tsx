import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import '../storefront.css'
import '../account/account.css'
import './wallet.css'

import type { WalletEntrySummary, WalletTransferSummary } from '@alo-noon/contracts'

import { BrandMark } from '../components/brand-mark'
import { ShieldIcon, TransferIcon, WalletIcon } from '../components/icons'
import { TopUpForm } from './top-up-form'
import { TransferForm } from './transfer-form'
import { formatToman, toPersianDigits } from '../../lib/persian'
import {
  currentSession,
  listWalletEntries,
  listWalletTransfers,
  readWallet,
} from '../../lib/shop-api'
import { transferStateLabel, walletEntryLabel, walletEntrySign } from '../../lib/wallet-view'

export const metadata: Metadata = {
  title: 'کیف پول | الو نون',
  robots: { index: false, follow: false },
}

/**
 * The balance, and the three things that can be done to it.
 *
 * Charge it, send some of it to somebody, and read what has happened to it. The
 * fourth thing — spending it — happens at checkout, where the decision actually
 * belongs; a "pay" button here would be a button with no order behind it.
 *
 * The balance is the first and largest thing on the page because it is the
 * question every visit to this screen is asking. Everything else is answering
 * "and why is it that number".
 */
export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await currentSession()
  if (!session) redirect('/account?next=/wallet')

  const [wallet, entries, transfers, params] = await Promise.all([
    readWallet(),
    listWalletEntries(),
    listWalletTransfers(),
    searchParams,
  ])

  // Checkout sends the amount that was missing, so somebody who arrived from a
  // short balance finds the field already holding what they came to add.
  const need = neededToman(params['need'])

  const pending = transfers.ok
    ? (transfers.data.find((transfer) => transfer.state === 'PENDING') ?? null)
    : null

  return (
    <div className="app-frame account">
      <header className="account__head wallet__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
        <Link className="an-button an-button--quiet" href="/account">
          حساب کاربری
        </Link>
      </header>

      <main className="account__body">
        <h1>کیف پول</h1>

        {!wallet.ok ? (
          <p className="wallet__failure">{wallet.error.message}</p>
        ) : (
          <>
            <section className="wallet__balance" aria-label="موجودی">
              <span className="wallet__balance-glyph">
                <WalletIcon duotone width={26} height={26} />
              </span>
              <div>
                <p className="wallet__balance-label">موجودی قابل استفاده</p>
                <p className="wallet__balance-amount">{formatToman(wallet.data.balance.amount)}</p>
              </div>
            </section>

            <TopUpForm {...(need !== null && { suggestedToman: need })} />

            <TransferForm pending={pending} />

            <Statement entries={entries.ok ? entries.data : []} />

            {transfers.ok && transfers.data.length > 0 && <Transfers transfers={transfers.data} />}
          </>
        )}

        <p className="wallet__reassure">
          <ShieldIcon width={16} height={16} />
          موجودی کیف پول برای پرداخت سفارش و انتقال به دیگران است؛ برداشت به حساب بانکی ندارد.
        </p>
      </main>
    </div>
  )
}

/**
 * The statement.
 *
 * Newest first, each line signed and carrying the balance it produced. The
 * running total travels with the line rather than being recomputed here: a
 * total derived on the reader's side is one that disagrees with the server the
 * moment a page boundary falls in the wrong place.
 */
function Statement({ entries }: { entries: readonly WalletEntrySummary[] }) {
  if (entries.length === 0) {
    return (
      <section className="wallet__section">
        <h2>گردش کیف پول</h2>
        <p className="wallet__empty">هنوز گردشی ثبت نشده است.</p>
      </section>
    )
  }

  return (
    <section className="wallet__section">
      <h2>گردش کیف پول</h2>
      <ol className="wallet__entries">
        {entries.map((entry) => {
          const sign = walletEntrySign(entry.kind)
          return (
            <li
              key={entry.id}
              className={`wallet-entry wallet-entry--${sign === '+' ? 'in' : 'out'}`}
            >
              <div className="wallet-entry__main">
                <p className="wallet-entry__label">{walletEntryLabel(entry.kind)}</p>
                <p className="wallet-entry__when">{persianDate(entry.createdAt)}</p>
              </div>
              <div className="wallet-entry__money">
                <p className="wallet-entry__amount">
                  <span aria-hidden="true">{sign}</span>
                  <span className="visually-hidden">{sign === '+' ? 'واریز' : 'برداشت'}</span>
                  {formatToman(entry.amount.amount)}
                </p>
                <p className="wallet-entry__after">
                  مانده: {formatToman(entry.balanceAfter.amount)}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/**
 * Transfers the customer started.
 *
 * Kept separate from the statement because a transfer that was never confirmed
 * moved no money and has no statement line — and it is exactly the one a
 * customer comes back to this page looking for.
 */
function Transfers({ transfers }: { transfers: readonly WalletTransferSummary[] }) {
  return (
    <section className="wallet__section">
      <h2>انتقال‌های شما</h2>
      <ol className="wallet__transfers">
        {transfers.map((transfer) => (
          <li key={transfer.id} className={`wallet-transfer is-${transfer.state.toLowerCase()}`}>
            <span className="wallet-transfer__glyph">
              <TransferIcon width={18} height={18} />
            </span>
            <div>
              <p className="wallet-transfer__who">
                به {transfer.recipientName ?? toPersianDigits(transfer.recipientMobileMasked)}
              </p>
              <p className="wallet-transfer__when">
                {transferStateLabel(transfer.state)} — {persianDate(transfer.createdAt)}
              </p>
            </div>
            <p className="wallet-transfer__amount">{formatToman(transfer.amount.amount)}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * The `?need=` a short checkout attached, in Toman, or null.
 *
 * Read defensively because it arrives from the address bar. A ceiling keeps a
 * hand-edited URL from pre-filling a form with a number long enough to be
 * somebody's idea of a joke; the API's own limits are the real ones.
 */
function neededToman(raw: string | string[] | undefined): number | null {
  const value = typeof raw === 'string' ? raw : null
  if (!value || !/^\d{1,15}$/.test(value)) return null
  const toman = Math.floor(Number(value) / 10)
  return toman > 0 && toman <= 500_000_000 ? toman : null
}

/**
 * A date a Persian reader recognises.
 *
 * `fa-IR` with the Persian calendar, which is the calendar on the wall. Falling
 * back to the raw instant rather than throwing: a statement line with an odd
 * date is readable, and a page that will not render is not.
 */
function persianDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
