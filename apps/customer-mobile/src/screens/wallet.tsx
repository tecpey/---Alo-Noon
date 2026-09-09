import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type {
  WalletEntrySummary,
  WalletSummary,
  WalletTransferSummary,
  WalletWithdrawalSummary,
} from '@alo-noon/contracts'
import { colors, ink, line, surface } from '@alo-noon/design-tokens'

import { formatMoney } from '../presentation'
import { sharedStyles } from '../theme'

/**
 * The balance, and the two things a customer can do to it from a phone.
 *
 * Charge it, and send part of it to somebody. Spending happens at checkout,
 * where there is an order to spend it on; a pay button here would be a button
 * with nothing behind it.
 *
 * Presentational, like every screen in this app: the state and every API call
 * live in App.tsx, so this file can be read as "what does the wallet look like"
 * without also being "how does the wallet work".
 */
export type WalletTransferStage =
  | { readonly step: 'idle' }
  /** A transfer is open and waiting for the code that was texted. */
  | { readonly step: 'confirming'; readonly transfer: WalletTransferSummary }
  | { readonly step: 'done'; readonly transfer: WalletTransferSummary }

/**
 * The amounts offered as one tap, in Toman.
 *
 * A numeric keypad is exactly where somebody meant to add fifty thousand and
 * added five hundred thousand. A tap cannot make that mistake.
 */
const PRESETS_TOMAN = [50_000, 100_000, 200_000, 500_000] as const

const ENTRY_LABELS: Readonly<Record<WalletEntrySummary['kind'], string>> = {
  TOP_UP: 'شارژ کیف پول',
  ORDER_PAYMENT: 'پرداخت سفارش',
  REFUND: 'بازگشت وجه سفارش',
  TRANSFER_IN: 'دریافت از کیف پول دیگر',
  TRANSFER_OUT: 'انتقال به کیف پول دیگر',
  WITHDRAWAL: 'برداشت به کارت بانکی',
  WITHDRAWAL_REVERSAL: 'بازگشت برداشت رد‌شده',
}

const INCOMING: ReadonlySet<WalletEntrySummary['kind']> = new Set([
  'TOP_UP',
  'REFUND',
  'TRANSFER_IN',
  'WITHDRAWAL_REVERSAL',
])

const WITHDRAWAL_STATES: Readonly<Record<WalletWithdrawalSummary['state'], string>> = {
  REQUESTED: 'در انتظار واریز',
  PAID: 'واریز شد',
  REJECTED: 'رد شد',
}

const TRANSFER_STATES: Readonly<Record<WalletTransferSummary['state'], string>> = {
  PENDING: 'در انتظار کد تأیید',
  COMPLETED: 'انجام شد',
  EXPIRED: 'منقضی شد',
  CANCELLED: 'لغو شد',
}

export function WalletScreen({
  wallet,
  entries,
  transfers,
  withdrawals,
  loading,
  busy,
  notice,
  transferStage,
  onTopUp,
  onOpenTransfer,
  onConfirmTransfer,
  onCancelTransfer,
  onRequestWithdrawal,
}: {
  wallet: WalletSummary | null
  entries: readonly WalletEntrySummary[]
  transfers: readonly WalletTransferSummary[]
  withdrawals: readonly WalletWithdrawalSummary[]
  loading: boolean
  /** True while a top-up, a transfer or a withdrawal is in flight. */
  busy: boolean
  /** What went wrong, or what just went right. */
  notice: { readonly tone: 'ok' | 'error'; readonly text: string } | null
  transferStage: WalletTransferStage
  onTopUp: (amountToman: string) => void
  onOpenTransfer: (input: { recipientMobile: string; amountToman: string }) => void
  onConfirmTransfer: (transferId: string, code: string) => void
  onCancelTransfer: () => void
  onRequestWithdrawal: (input: {
    amountToman: string
    cardNumber: string
    cardHolderName: string
    iban: string
  }) => void
}) {
  const [topUpAmount, setTopUpAmount] = useState(String(PRESETS_TOMAN[1]))
  const [recipient, setRecipient] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [code, setCode] = useState('')
  // Folded away until asked for. Almost nobody wants this on almost any visit —
  // the balance is there to be spent — and a card-number field sitting open on
  // a screen somebody opened to check a number is a field filled in by mistake.
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [cardNumber, setCardNumber] = useState('')
  const [cardHolder, setCardHolder] = useState('')
  const [iban, setIban] = useState('')

  return (
    <View style={{ gap: 20 }}>
      {/*
        The figure first and largest. It is the question every visit to this
        screen is asking, and everything under it is the answer to "and why is
        it that number".
      */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>موجودی قابل استفاده</Text>
        {loading && !wallet ? (
          <ActivityIndicator color={colors.primary[700]} />
        ) : (
          <Text style={styles.balanceAmount}>
            {wallet ? formatMoney(wallet.balance.amount) : '—'}
          </Text>
        )}
      </View>

      {notice && (
        <Text
          style={notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}
          accessibilityLiveRegion="polite"
        >
          {notice.text}
        </Text>
      )}

      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>شارژ کیف پول</Text>
        <Text style={sharedStyles.subtitle}>
          مبلغ را انتخاب کنید یا خودتان بنویسید. پرداخت از درگاه بانکی انجام می‌شود.
        </Text>

        <View style={styles.presets}>
          {PRESETS_TOMAN.map((preset) => {
            const chosen = String(preset) === topUpAmount
            return (
              <Pressable
                key={preset}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                accessibilityLabel={`${preset.toLocaleString('fa-IR')} تومان`}
                onPress={() => setTopUpAmount(String(preset))}
                disabled={busy}
                style={[styles.preset, chosen && styles.presetOn]}
              >
                <Text style={[styles.presetText, chosen && styles.presetTextOn]}>
                  {preset.toLocaleString('fa-IR')}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <TextInput
          accessibilityLabel="مبلغ شارژ به تومان"
          value={topUpAmount}
          onChangeText={setTopUpAmount}
          keyboardType="number-pad"
          placeholder="مبلغ به تومان"
          editable={!busy}
          style={styles.input}
        />
        <Action label="پرداخت و شارژ" busy={busy} onPress={() => onTopUp(topUpAmount)} />
      </View>

      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>انتقال به کیف پول دیگر</Text>

        {transferStage.step === 'confirming' ? (
          <>
            {/* Who and how much, restated at the size of a decision. This is the
                last chance anybody has to notice a mistyped digit. */}
            <Text style={styles.confirmLine}>
              <Text style={styles.confirmStrong}>
                {formatMoney(transferStage.transfer.amount.amount)}
              </Text>
              {' به '}
              <Text style={styles.confirmStrong}>
                {transferStage.transfer.recipientName ??
                  transferStage.transfer.recipientMobileMasked}
              </Text>
            </Text>
            <Text style={sharedStyles.subtitle}>کد تأیید به شمارهٔ خودتان پیامک شد.</Text>
            <TextInput
              accessibilityLabel="کد تأیید"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              placeholder="------"
              editable={!busy}
              style={[styles.input, styles.codeInput]}
            />
            <Action
              label="تأیید و انتقال"
              busy={busy}
              onPress={() => onConfirmTransfer(transferStage.transfer.id, code)}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCode('')
                onCancelTransfer()
              }}
              disabled={busy}
            >
              <Text style={sharedStyles.linkText}>انصراف</Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              accessibilityLabel="شمارهٔ موبایل گیرنده"
              value={recipient}
              onChangeText={setRecipient}
              keyboardType="phone-pad"
              placeholder="۰۹۱۲۱۲۳۴۵۶۷"
              editable={!busy}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="مبلغ انتقال به تومان"
              value={transferAmount}
              onChangeText={setTransferAmount}
              keyboardType="number-pad"
              placeholder="مبلغ به تومان"
              editable={!busy}
              style={styles.input}
            />
            <Action
              label="ادامه"
              busy={busy}
              onPress={() => {
                setCode('')
                onOpenTransfer({ recipientMobile: recipient, amountToman: transferAmount })
              }}
            />
            <Text style={styles.fineprint}>
              گیرنده باید قبلاً در الو نون ثبت‌نام کرده باشد. انتقال بدون کد تأیید انجام نمی‌شود.
            </Text>
          </>
        )}
      </View>

      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>برداشت به کارت بانکی</Text>
        <Text style={styles.fineprint}>
          موجودی کیف پول پول خودتان است و می‌توانید آن را پس بگیرید. واریز دستی و در روزهای کاری
          انجام می‌شود؛ معمولاً یک تا سه روز کاری.
        </Text>
        {withdrawOpen ? (
          <>
            <TextInput
              accessibilityLabel="مبلغ برداشت به تومان"
              value={withdrawAmount}
              onChangeText={setWithdrawAmount}
              keyboardType="number-pad"
              placeholder="مبلغ به تومان"
              editable={!busy}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="شمارهٔ کارت ۱۶ رقمی"
              value={cardNumber}
              onChangeText={setCardNumber}
              keyboardType="number-pad"
              placeholder="شمارهٔ کارت ۱۶ رقمی"
              editable={!busy}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="نام صاحب کارت"
              value={cardHolder}
              onChangeText={setCardHolder}
              placeholder="نام صاحب کارت"
              editable={!busy}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="شبا، اختیاری"
              value={iban}
              onChangeText={setIban}
              autoCapitalize="characters"
              placeholder="شبا (اختیاری) — IR..."
              editable={!busy}
              style={styles.input}
            />
            <Action
              label="ثبت درخواست"
              busy={busy}
              onPress={() => {
                onRequestWithdrawal({
                  amountToman: withdrawAmount,
                  cardNumber,
                  cardHolderName: cardHolder,
                  iban,
                })
                // The card has done its one job. Cleared here rather than left
                // sitting in a text field behind whatever the customer opens
                // next.
                setCardNumber('')
                setIban('')
              }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => setWithdrawOpen(false)}
              disabled={busy}
            >
              <Text style={sharedStyles.linkText}>انصراف</Text>
            </Pressable>
            <Text style={styles.fineprint}>
              کارت باید به نام خودتان باشد. واریز به کارت شخص دیگر انجام نمی‌شود.
            </Text>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setWithdrawOpen(true)}
            disabled={busy || wallet?.balance.amount === '0'}
          >
            <Text style={sharedStyles.linkText}>
              {wallet?.balance.amount === '0' ? 'موجودی برای برداشت ندارید' : 'درخواست برداشت'}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>گردش کیف پول</Text>
        {entries.length === 0 ? (
          <Text style={sharedStyles.emptyText}>هنوز گردشی ثبت نشده است.</Text>
        ) : (
          <View>
            {entries.map((entry, index) => (
              <EntryRow key={entry.id} entry={entry} last={index === entries.length - 1} />
            ))}
          </View>
        )}
      </View>

      {transfers.length > 0 && (
        <View style={sharedStyles.card}>
          <Text style={sharedStyles.title}>انتقال‌های شما</Text>
          <View>
            {transfers.map((transfer, index) => (
              <View
                key={transfer.id}
                style={[
                  sharedStyles.listRow,
                  index === transfers.length - 1 && sharedStyles.listRowLast,
                ]}
              >
                <View style={sharedStyles.rowBetween}>
                  <Text style={sharedStyles.value}>
                    به {transfer.recipientName ?? transfer.recipientMobileMasked}
                  </Text>
                  <Text style={sharedStyles.value}>{formatMoney(transfer.amount.amount)}</Text>
                </View>
                <Text style={sharedStyles.label}>{TRANSFER_STATES[transfer.state]}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/*
        Kept out of the statement for the same reason transfers are: a refused
        withdrawal moved money twice and nets to nothing, and the statement will
        show both halves without ever saying why. The reason lives here.
      */}
      {withdrawals.length > 0 && (
        <View style={sharedStyles.card}>
          <Text style={sharedStyles.title}>برداشت‌های شما</Text>
          <View>
            {withdrawals.map((withdrawal, index) => (
              <View
                key={withdrawal.id}
                style={[
                  sharedStyles.listRow,
                  index === withdrawals.length - 1 && sharedStyles.listRowLast,
                ]}
              >
                <View style={sharedStyles.rowBetween}>
                  <Text style={sharedStyles.value}>کارت **** {withdrawal.cardLastFour}</Text>
                  <Text style={sharedStyles.value}>{formatMoney(withdrawal.amount.amount)}</Text>
                </View>
                <Text style={sharedStyles.label}>{WITHDRAWAL_STATES[withdrawal.state]}</Text>
                {withdrawal.rejectionReason && (
                  <Text style={styles.fineprint}>{withdrawal.rejectionReason}</Text>
                )}
                {withdrawal.bankReference && (
                  <Text style={styles.fineprint}>{withdrawal.bankReference}</Text>
                )}
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

/**
 * One statement line.
 *
 * A sign as well as a colour. Colour is the first thing a bright morning, a
 * screenshot and a colour-blind reader all lose, and the direction of a money
 * line is the one thing that must not be ambiguous.
 */
function EntryRow({ entry, last }: { entry: WalletEntrySummary; last: boolean }) {
  const incoming = INCOMING.has(entry.kind)
  return (
    <View style={[sharedStyles.listRow, last && sharedStyles.listRowLast]}>
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.value}>{ENTRY_LABELS[entry.kind]}</Text>
        <Text style={[sharedStyles.value, incoming && styles.incoming]}>
          {incoming ? '+' : '−'} {formatMoney(entry.amount.amount)}
        </Text>
      </View>
      <Text style={sharedStyles.label}>مانده: {formatMoney(entry.balanceAfter.amount)}</Text>
    </View>
  )
}

function Action({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      onPress={onPress}
      disabled={busy}
      style={[styles.action, busy && styles.actionBusy]}
    >
      {busy ? (
        <ActivityIndicator color={surface.card} />
      ) : (
        <Text style={styles.actionText}>{label}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  balanceCard: {
    gap: 6,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.primary[200],
    borderRadius: 28,
    backgroundColor: surface.sunken,
  },
  balanceLabel: { color: ink.muted, fontSize: 14, textAlign: 'right' },
  balanceAmount: {
    color: colors.neutral[900],
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'right',
  },

  presets: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  preset: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 999,
    backgroundColor: surface.card,
  },
  presetOn: { borderColor: colors.primary[700], backgroundColor: surface.sunken },
  presetText: { color: ink.muted, fontSize: 14, fontWeight: '700' },
  presetTextOn: { color: ink.strong },

  input: {
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 16,
    backgroundColor: surface.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    color: ink.strong,
    // Numbers read left to right even inside a right-to-left screen.
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  codeInput: { letterSpacing: 8, fontWeight: '800' },

  action: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: 18,
    backgroundColor: colors.primary[700],
  },
  actionBusy: { opacity: 0.75 },
  actionText: { color: surface.card, fontSize: 16, fontWeight: '800' },

  confirmLine: {
    color: ink.base,
    fontSize: 17,
    lineHeight: 32,
    textAlign: 'right',
  },
  confirmStrong: { color: ink.strong, fontWeight: '800' },

  incoming: { color: colors.success },
  noticeOk: { color: colors.success, fontSize: 14, lineHeight: 24, textAlign: 'right' },
  noticeError: { color: colors.error, fontSize: 14, lineHeight: 24, textAlign: 'right' },
  fineprint: { color: ink.muted, fontSize: 12, lineHeight: 22, textAlign: 'right' },
})
