import { useCallback, useEffect, useMemo, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import type { DeliveryTaskView } from '@alo-noon/contracts'
import { parseIranianMobile, parseOtpCode } from '@alo-noon/domain'
import { colors } from '@alo-noon/design-tokens'

import { createCourierApiClient, CourierApiError, type CourierReport } from './src/api'
import { courierCopy } from './src/copy'
import {
  courierErrorMessage,
  courierStepFor,
  FAILURE_REASONS,
  formatDeadline,
  formatRials,
  TASK_STATE_LABELS,
  telHref,
} from './src/presentation'

/**
 * The courier's app.
 *
 * One list, one card per order, one obvious action per card. The person holding
 * this phone is outdoors, one-handed, and often in a hurry, so nothing here is a
 * menu: the delivery has exactly one forward step from wherever it is, and the
 * screen shows that step as a button big enough to hit without looking.
 *
 * `NOT_A_COURIER` gets a screen of its own rather than an empty list. Someone
 * whose sign-in worked but who is not on the roster has a problem the office
 * solves, and showing them "no deliveries" would send them to wait for work that
 * will never arrive.
 */
type Screen = 'boot' | 'phone' | 'otp' | 'deliveries' | 'not-a-courier'

const apiBaseUrl = process.env['EXPO_PUBLIC_API_BASE_URL']

export default function App() {
  const api = useMemo(() => {
    if (!apiBaseUrl) return null
    try {
      return createCourierApiClient(apiBaseUrl)
    } catch {
      return null
    }
  }, [])

  const [screen, setScreen] = useState<Screen>('boot')
  const [tasks, setTasks] = useState<DeliveryTaskView[]>([])
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [challengeId, setChallengeId] = useState<string>()
  const [otpCommand, setOtpCommand] = useState<{ mobileE164: string; idempotencyKey: string }>()
  const [busyTaskId, setBusyTaskId] = useState<string>()
  const [failingTaskId, setFailingTaskId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string>()

  const loadDeliveries = useCallback(async () => {
    if (!api) return
    try {
      setTasks(await api.listDeliveries())
      setScreen('deliveries')
      setMessage(undefined)
    } catch (error) {
      if (error instanceof CourierApiError && error.code === 'NOT_A_COURIER') {
        setScreen('not-a-courier')
        return
      }
      if (error instanceof CourierApiError && error.status === 401) {
        setScreen('phone')
        return
      }
      setMessage(errorMessage(error))
    }
  }, [api])

  useEffect(() => {
    if (!api) {
      setMessage('نشانی سرور در این نسخه تنظیم نشده است.')
      setScreen('phone')
      return
    }
    let active = true
    void api
      .getSession()
      .then(async (session) => {
        if (!active) return
        if (!session) {
          setScreen('phone')
          return
        }
        await loadDeliveries()
      })
      .catch((error: unknown) => {
        if (!active) return
        setMessage(errorMessage(error))
        setScreen('phone')
      })
    return () => {
      active = false
    }
  }, [api, loadDeliveries])

  const requestOtp = async () => {
    if (!api || busy) return
    const mobileE164 = parseIranianMobile(phone)
    if (!mobileE164) {
      setMessage('شماره موبایل معتبر ایران وارد کنید.')
      return
    }
    setBusy(true)
    setMessage(undefined)
    // The same number retried reuses its key, so a second tap on a slow
    // connection does not spend another paid message.
    const command =
      otpCommand?.mobileE164 === mobileE164
        ? otpCommand
        : { mobileE164, idempotencyKey: commandKey() }
    setOtpCommand(command)
    try {
      const challenge = await api.requestOtp(mobileE164, command.idempotencyKey)
      setChallengeId(challenge.challengeId)
      setOtp('')
      setOtpCommand(undefined)
      setScreen('otp')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const verifyOtp = async () => {
    if (!api || !challengeId || busy) return
    const code = parseOtpCode(otp)
    if (!code) {
      setMessage('کد باید دقیقاً شش رقم باشد.')
      return
    }
    setBusy(true)
    setMessage(undefined)
    try {
      await api.verifyOtp(challengeId, code)
      await loadDeliveries()
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    if (!api || busy) return
    setBusy(true)
    try {
      await api.logout()
    } catch {
      // Signing out locally matters more than the server acknowledging it.
    } finally {
      setTasks([])
      setChallengeId(undefined)
      setOtp('')
      setBusy(false)
      setMessage(undefined)
      setScreen('phone')
    }
  }

  /**
   * Replaces one task with what the API just returned.
   *
   * A delivered or cancelled order leaves the list because the API would not
   * return it on the next read either — keeping it would show a courier work
   * they no longer have.
   */
  const settle = (updated: DeliveryTaskView) => {
    setTasks((current) =>
      updated.state === 'DELIVERED' || updated.state === 'CANCELLED'
        ? current.filter((task) => task.taskId !== updated.taskId)
        : current.map((task) => (task.taskId === updated.taskId ? updated : task)),
    )
  }

  const answerOffer = async (taskId: string, accept: boolean) => {
    if (!api || busyTaskId) return
    setBusyTaskId(taskId)
    setMessage(undefined)
    try {
      const updated = await api.respond(taskId, accept)
      // Declining hands the order back, so it is no longer this courier's.
      if (accept) settle(updated)
      else setTasks((current) => current.filter((task) => task.taskId !== taskId))
    } catch (error) {
      setMessage(errorMessage(error))
      // The state this screen is showing is stale if the API refused, so the
      // safest thing to put in front of the courier is the truth.
      await loadDeliveries()
    } finally {
      setBusyTaskId(undefined)
    }
  }

  const report = async (taskId: string, to: CourierReport, reasonCode?: string) => {
    if (!api || busyTaskId) return
    setBusyTaskId(taskId)
    setMessage(undefined)
    try {
      settle(await api.report(taskId, to, reasonCode))
      setFailingTaskId(undefined)
    } catch (error) {
      setMessage(errorMessage(error))
      await loadDeliveries()
    } finally {
      setBusyTaskId(undefined)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    await loadDeliveries()
    setRefreshing(false)
  }

  if (screen === 'boot') {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color={colors.primary[500]} size="large" />
        <StatusBar style="light" />
      </SafeAreaView>
    )
  }

  if (screen === 'not-a-courier') {
    return (
      <SafeAreaView style={styles.centered}>
        <View style={styles.card}>
          <Text style={styles.brand}>الو نون پیک</Text>
          <Text style={styles.title}>هنوز در فهرست پیک‌ها نیستید</Text>
          <Text style={styles.body}>
            ورودتان انجام شد، ولی این شماره به‌عنوان پیک ثبت نشده است. از دفتر بخواهید شما را با
            همین شماره ثبت کند و بعد دوباره وارد شوید.
          </Text>
          <Pressable style={styles.secondaryButton} onPress={() => void signOut()}>
            <Text style={styles.secondaryButtonText}>خروج</Text>
          </Pressable>
        </View>
        <StatusBar style="light" />
      </SafeAreaView>
    )
  }

  if (screen === 'phone' || screen === 'otp') {
    return (
      <SafeAreaView style={styles.centered}>
        <View style={styles.card}>
          <Text style={styles.brand}>الو نون پیک</Text>
          <Text style={styles.title}>{courierCopy.title}</Text>
          <Text style={styles.body}>
            {screen === 'phone' ? courierCopy.subtitle : 'کد شش‌رقمی پیامک‌شده را وارد کنید.'}
          </Text>

          {screen === 'phone' ? (
            <>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="۰۹۱۲۱۲۳۴۵۶۷"
                placeholderTextColor={colors.neutral[400]}
                keyboardType="phone-pad"
                textAlign="right"
                editable={!busy}
              />
              <Pressable
                style={[styles.primaryButton, busy && styles.buttonBusy]}
                onPress={() => void requestOtp()}
                disabled={busy}
              >
                <Text style={styles.primaryButtonText}>{busy ? 'در حال ارسال…' : 'دریافت کد'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                style={[styles.input, styles.otpInput]}
                value={otp}
                onChangeText={setOtp}
                placeholder="------"
                placeholderTextColor={colors.neutral[400]}
                keyboardType="number-pad"
                maxLength={8}
                textAlign="center"
                editable={!busy}
              />
              <Pressable
                style={[styles.primaryButton, busy && styles.buttonBusy]}
                onPress={() => void verifyOtp()}
                disabled={busy}
              >
                <Text style={styles.primaryButtonText}>{busy ? 'در حال بررسی…' : 'ورود'}</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  setScreen('phone')
                  setMessage(undefined)
                }}
              >
                <Text style={styles.secondaryButtonText}>تغییر شماره</Text>
              </Pressable>
            </>
          )}

          {message && <Text style={styles.error}>{message}</Text>}
        </View>
        <StatusBar style="light" />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>سفارش‌های شما</Text>
        <Pressable onPress={() => void signOut()} hitSlop={12}>
          <Text style={styles.headerAction}>خروج</Text>
        </Pressable>
      </View>

      {message && <Text style={styles.errorBanner}>{message}</Text>}

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.primary[400]}
          />
        }
      >
        {tasks.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.title}>فعلاً سفارشی ندارید</Text>
            <Text style={styles.body}>
              وقتی دفتر سفارشی به شما بدهد همین‌جا می‌آید. برای بررسی دوباره، صفحه را بکشید پایین.
            </Text>
          </View>
        ) : (
          tasks.map((task) => (
            <DeliveryCard
              key={task.taskId}
              task={task}
              busy={busyTaskId === task.taskId}
              failing={failingTaskId === task.taskId}
              onAnswer={(accept) => void answerOffer(task.taskId, accept)}
              onReport={(to, reasonCode) => void report(task.taskId, to, reasonCode)}
              onStartFailing={() => setFailingTaskId(task.taskId)}
              onCancelFailing={() => setFailingTaskId(undefined)}
            />
          ))
        )}
      </ScrollView>
      <StatusBar style="light" />
    </SafeAreaView>
  )
}

function DeliveryCard({
  task,
  busy,
  failing,
  onAnswer,
  onReport,
  onStartFailing,
  onCancelFailing,
}: Readonly<{
  task: DeliveryTaskView
  busy: boolean
  failing: boolean
  onAnswer: (accept: boolean) => void
  onReport: (to: CourierReport, reasonCode?: string) => void
  onStartFailing: () => void
  onCancelFailing: () => void
}>) {
  const step = courierStepFor(task.state)
  // Pulled out so the narrowing survives into the button's callback.
  const primary = step.primary
  const deadline = formatDeadline(task.deliverBefore)
  const call = telHref(task.recipientPhone)

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.orderCode}>{task.orderPublicId}</Text>
        <Text style={styles.stateBadge}>{TASK_STATE_LABELS[task.state] ?? task.state}</Text>
      </View>

      <Text style={styles.address}>{task.address}</Text>
      <Text style={styles.body}>گیرنده: {task.recipientName}</Text>
      <Text style={styles.body}>تحویل‌گیری از: {task.bakeryName}</Text>
      {deadline && <Text style={styles.deadline}>تا ساعت {deadline}</Text>}

      {/* Prepaid, always: an order cannot be accepted before its payment is
          captured, so a courier must never be asked for money at the door. */}
      <Text style={styles.paidNote}>
        {formatRials(task.totalAmount)} — پرداخت‌شده. از مشتری پول نگیرید.
      </Text>

      {call && (
        <Pressable style={styles.callButton} onPress={() => void Linking.openURL(call)}>
          <Text style={styles.callButtonText}>تماس با گیرنده</Text>
        </Pressable>
      )}

      {task.attemptCount > 0 && (
        <Text style={styles.body}>این تلاش شمارهٔ {task.attemptCount + 1} است.</Text>
      )}

      {task.state === 'FAILED' && (
        <Text style={styles.body}>ثبت شد. تا وقتی دفتر سفارش را پس نگیرد، نان دست شماست.</Text>
      )}

      {failing ? (
        <View style={styles.reasonBlock}>
          <Text style={styles.body}>چرا تحویل نشد؟</Text>
          {FAILURE_REASONS.map((reason) => (
            <Pressable
              key={reason.code}
              style={[styles.reasonButton, busy && styles.buttonBusy]}
              onPress={() => onReport('FAILED', reason.code)}
              disabled={busy}
            >
              <Text style={styles.reasonButtonText}>{reason.label}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.secondaryButton} onPress={onCancelFailing} disabled={busy}>
            <Text style={styles.secondaryButtonText}>بی‌خیال</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {step.isOffer && (
            <View style={styles.offerRow}>
              <Pressable
                style={[styles.primaryButton, styles.grow, busy && styles.buttonBusy]}
                onPress={() => onAnswer(true)}
                disabled={busy}
              >
                <Text style={styles.primaryButtonText}>{busy ? '…' : 'قبول می‌کنم'}</Text>
              </Pressable>
              <Pressable
                style={[styles.declineButton, busy && styles.buttonBusy]}
                onPress={() => onAnswer(false)}
                disabled={busy}
              >
                <Text style={styles.declineButtonText}>نمی‌توانم</Text>
              </Pressable>
            </View>
          )}

          {primary && (
            <Pressable
              style={[styles.primaryButton, busy && styles.buttonBusy]}
              onPress={() => onReport(primary.to)}
              disabled={busy}
            >
              <Text style={styles.primaryButtonText}>{busy ? 'در حال ثبت…' : primary.label}</Text>
            </Pressable>
          )}

          {step.canFail && (
            <Pressable style={styles.secondaryButton} onPress={onStartFailing} disabled={busy}>
              <Text style={styles.secondaryButtonText}>تحویل نشد</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  )
}

function commandKey(): string {
  return `courier-otp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function errorMessage(error: unknown): string {
  if (error instanceof CourierApiError) return courierErrorMessage(error.code)
  return 'ارتباط برقرار نشد. اتصال اینترنت را بررسی کنید.'
}

// Large touch targets throughout: this is used one-handed, outdoors, often in
// a hurry. Nothing important is smaller than a thumb.
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.neutral[800] },
  centered: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.neutral[800],
    padding: 20,
  },
  header: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  headerTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  headerAction: { color: colors.primary[300], fontSize: 16, fontWeight: '700' },
  list: { padding: 16, gap: 14, paddingBottom: 40 },
  card: {
    gap: 10,
    padding: 20,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },
  cardHead: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  orderCode: { color: colors.neutral[900], fontSize: 20, fontWeight: '700', textAlign: 'right' },
  stateBadge: {
    color: colors.primary[700],
    backgroundColor: colors.primary[50],
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    fontSize: 13,
    fontWeight: '700',
    overflow: 'hidden',
  },
  brand: { color: colors.primary[600], fontSize: 17, fontWeight: '700', textAlign: 'right' },
  title: { color: colors.neutral[900], fontSize: 26, fontWeight: '700', textAlign: 'right' },
  // The address is what the courier is actually looking for, so it is the
  // largest thing on the card after the order code.
  address: { color: colors.neutral[900], fontSize: 19, lineHeight: 32, textAlign: 'right' },
  body: { color: colors.neutral[600], fontSize: 15, lineHeight: 26, textAlign: 'right' },
  deadline: { color: colors.warning, fontSize: 16, fontWeight: '700', textAlign: 'right' },
  paidNote: {
    color: colors.success,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'right',
    lineHeight: 26,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.neutral[300],
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 19,
    color: colors.neutral[900],
  },
  otpInput: { letterSpacing: 8, fontSize: 24 },
  primaryButton: {
    minHeight: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: colors.primary[600],
    paddingHorizontal: 20,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  secondaryButton: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.neutral[300],
  },
  secondaryButtonText: { color: colors.neutral[700], fontSize: 16, fontWeight: '700' },
  declineButton: {
    minHeight: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.neutral[300],
    paddingHorizontal: 18,
  },
  declineButtonText: { color: colors.neutral[700], fontSize: 17, fontWeight: '700' },
  offerRow: { flexDirection: 'row-reverse', gap: 10 },
  grow: { flex: 1 },
  callButton: {
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: colors.neutral[100],
  },
  callButtonText: { color: colors.neutral[900], fontSize: 17, fontWeight: '700' },
  reasonBlock: { gap: 10 },
  reasonButton: {
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.primary[200],
    backgroundColor: colors.primary[50],
  },
  reasonButtonText: { color: colors.primary[800], fontSize: 16, fontWeight: '700' },
  buttonBusy: { opacity: 0.6 },
  error: { color: colors.error, fontSize: 15, textAlign: 'right', lineHeight: 26 },
  errorBanner: {
    color: '#FFFFFF',
    backgroundColor: colors.error,
    marginHorizontal: 16,
    padding: 14,
    borderRadius: 14,
    fontSize: 15,
    textAlign: 'right',
    lineHeight: 26,
  },
})
