import { DomainError } from './errors'

/**
 * What the operator is told, and — more importantly — what they are not told
 * twice.
 *
 * These conditions already exist in the system. Every one of them is written to
 * the server log today, where nobody is looking: a gateway that went unhealthy
 * overnight is discovered by a customer failing to pay, and events that
 * exhausted their retries are discovered never.
 *
 * The hard part is not detecting them. It is that a condition which is true is
 * usually true for hours, and something that fires every sweep is an alert
 * nobody reads by the third morning. So each kind carries a quiet period, and a
 * repeat inside it is suppressed — deliberately, and recorded as suppressed
 * rather than dropped, because "we knew and said nothing" is a different fact
 * from "we did not know".
 */
export const OPERATOR_ALERT_KINDS = [
  /** A payment gateway is no longer selectable. Customers cannot pay. */
  'PAYMENT_GATEWAY_UNHEALTHY',
  /** Domain events gave up after exhausting their attempts. Each is somebody who was not told something. */
  'OUTBOX_EVENTS_PARKED',
  /** Money taken from a customer that we still have not recorded. */
  'PAYMENTS_AWAITING_SETTLEMENT',
  /** No SMS service is selectable, so nobody can sign in. */
  'SMS_PROVIDER_UNAVAILABLE',
] as const

export type OperatorAlertKind = (typeof OPERATOR_ALERT_KINDS)[number]

export type OperatorAlertSeverity = 'WARNING' | 'CRITICAL'

export interface OperatorAlertDefinition {
  readonly kind: OperatorAlertKind
  readonly severity: OperatorAlertSeverity
  /**
   * How long the same kind stays quiet after being sent.
   *
   * Chosen per condition rather than globally, because the right cadence
   * depends on what the operator can do about it. Nobody can fix a gateway
   * faster by being told every fifteen minutes; unremitted cash genuinely
   * wants a daily nudge and nothing more.
   */
  readonly quietPeriodMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const OPERATOR_ALERT_DEFINITIONS: Readonly<
  Record<OperatorAlertKind, OperatorAlertDefinition>
> = Object.freeze({
  // Nobody can pay. Worth the interruption, and worth repeating while it lasts
  // — but hourly, because the fix is a phone call to the provider and being
  // told four times in an hour does not speed that call up.
  PAYMENT_GATEWAY_UNHEALTHY: {
    kind: 'PAYMENT_GATEWAY_UNHEALTHY',
    severity: 'CRITICAL',
    quietPeriodMs: HOUR,
  },
  // Nobody can sign in, which for this product means nobody new can order.
  SMS_PROVIDER_UNAVAILABLE: {
    kind: 'SMS_PROVIDER_UNAVAILABLE',
    severity: 'CRITICAL',
    quietPeriodMs: HOUR,
  },
  // Money is involved and the window to reconcile it with the gateway is not
  // indefinite, so this is loud and repeats while it is true.
  PAYMENTS_AWAITING_SETTLEMENT: {
    kind: 'PAYMENTS_AWAITING_SETTLEMENT',
    severity: 'CRITICAL',
    quietPeriodMs: HOUR,
  },
  // Parked events are permanent until a person acts: nothing will retry them.
  // Six hours is enough that a working day gets at most two.
  OUTBOX_EVENTS_PARKED: {
    kind: 'OUTBOX_EVENTS_PARKED',
    severity: 'WARNING',
    quietPeriodMs: 6 * HOUR,
  },
})

export interface OperatorAlertObservation {
  readonly kind: OperatorAlertKind
  /**
   * How many things are wrong — orders unsettled, events parked. Zero means
   * the condition has cleared.
   */
  readonly count: number
  /** Short Persian detail; goes into the body under the summary line. */
  readonly detailFa: string
}

export interface OperatorAlertDecision {
  readonly kind: OperatorAlertKind
  readonly severity: OperatorAlertSeverity
  readonly send: boolean
  readonly reason: 'FIRING' | 'QUIET_PERIOD' | 'CLEARED'
  /** When this kind may next be sent, if it is sent now. */
  readonly nextEligibleAt: Date
}

/**
 * Whether to send, given what was last sent for this kind.
 *
 * A cleared condition is never sent — there is no "all clear" message, on
 * purpose. An operator who gets one learns to skim, and the next real alert
 * arrives looking like the last four that meant nothing. The panel shows
 * current state; email is only for what needs a person now.
 */
export function decideOperatorAlert(
  observation: OperatorAlertObservation,
  lastSentAt: Date | null,
  now: Date,
): OperatorAlertDecision {
  const definition = OPERATOR_ALERT_DEFINITIONS[observation.kind]
  if (!definition) {
    throw new DomainError('OPERATOR_ALERT_KIND_UNKNOWN', `Unknown alert kind ${observation.kind}`)
  }
  if (!Number.isSafeInteger(observation.count) || observation.count < 0) {
    throw new DomainError(
      'OPERATOR_ALERT_COUNT_INVALID',
      'An alert count must be a non-negative integer',
    )
  }

  const nextEligibleAt = new Date(now.getTime() + definition.quietPeriodMs)

  if (observation.count === 0) {
    return {
      kind: definition.kind,
      severity: definition.severity,
      send: false,
      reason: 'CLEARED',
      nextEligibleAt,
    }
  }

  if (lastSentAt !== null) {
    const elapsed = now.getTime() - lastSentAt.getTime()
    // A last-sent timestamp in the future means a clock moved backwards. Treat
    // it as quiet rather than as elapsed: a jumped clock should not turn into a
    // burst of mail.
    if (elapsed < definition.quietPeriodMs) {
      return {
        kind: definition.kind,
        severity: definition.severity,
        send: false,
        reason: 'QUIET_PERIOD',
        nextEligibleAt: new Date(lastSentAt.getTime() + definition.quietPeriodMs),
      }
    }
  }

  return {
    kind: definition.kind,
    severity: definition.severity,
    send: true,
    reason: 'FIRING',
    nextEligibleAt,
  }
}

const SEVERITY_FA: Readonly<Record<OperatorAlertSeverity, string>> = {
  CRITICAL: 'بحرانی',
  WARNING: 'هشدار',
}

const KIND_SUBJECT_FA: Readonly<Record<OperatorAlertKind, string>> = {
  PAYMENT_GATEWAY_UNHEALTHY: 'درگاه پرداخت از کار افتاده',
  SMS_PROVIDER_UNAVAILABLE: 'سرویس پیامک در دسترس نیست',
  PAYMENTS_AWAITING_SETTLEMENT: 'پرداخت‌های تسویه‌نشده',
  OUTBOX_EVENTS_PARKED: 'پیام‌هایی که ارسال نشدند',
}

/**
 * What the operator actually reads, in Persian, at four in the morning.
 *
 * The subject carries the severity and whose business it is, because on a phone
 * that is often all that is seen before the decision to get up or not. The
 * tenant name is whatever the tenant is called — the schema has one name field
 * and no Persian-specific one, so this does not pretend otherwise. The body says
 * what is wrong, what it means for the business, and where to go — in that
 * order, because the last one is useless without the second.
 */
export function composeOperatorAlert(
  observation: OperatorAlertObservation,
  tenantName: string,
  panelUrl: string,
): { subject: string; body: string } {
  const definition = OPERATOR_ALERT_DEFINITIONS[observation.kind]
  if (!definition) {
    throw new DomainError('OPERATOR_ALERT_KIND_UNKNOWN', `Unknown alert kind ${observation.kind}`)
  }

  const subject = `[${SEVERITY_FA[definition.severity]}] ${KIND_SUBJECT_FA[observation.kind]} — ${tenantName}`
  const body = [
    observation.detailFa,
    '',
    CONSEQUENCE_FA[observation.kind],
    '',
    `پنل: ${panelUrl}`,
    '',
    'این پیام خودکار است. تا وقتی وضعیت برطرف نشود ممکن است دوباره بیاید،',
    `ولی نه زودتر از ${humanQuietPeriodFa(definition.quietPeriodMs)}.`,
  ].join('\n')

  return { subject, body }
}

const CONSEQUENCE_FA: Readonly<Record<OperatorAlertKind, string>> = {
  PAYMENT_GATEWAY_UNHEALTHY:
    'یعنی هیچ مشتری‌ای نمی‌تواند پرداخت کند، و چون سفارش پیش از پرداخت قطعی نمی‌شود، هیچ سفارشی هم ثبت نمی‌شود. فروش متوقف است.',
  SMS_PROVIDER_UNAVAILABLE:
    'یعنی هیچ‌کس نمی‌تواند وارد شود، چون کد ورود فرستاده نمی‌شود. مشتری تازه سفارش نمی‌دهد.',
  PAYMENTS_AWAITING_SETTLEMENT:
    'یعنی پولی از مشتری گرفته شده و هنوز در دفاتر ما ثبت نشده. این خودش را درست نمی‌کند.',
  OUTBOX_EVENTS_PARKED:
    'هر کدام یک مشتری است که خبردار نشد. هیچ‌چیز دوباره تلاش نمی‌کند؛ باید دستی رسیدگی شود.',
}

function humanQuietPeriodFa(quietPeriodMs: number): string {
  const hours = Math.round(quietPeriodMs / HOUR)
  if (hours >= 24) return 'یک شبانه‌روز دیگر'
  if (hours === 1) return 'یک ساعت دیگر'
  return `${hours.toLocaleString('fa-IR')} ساعت دیگر`
}
