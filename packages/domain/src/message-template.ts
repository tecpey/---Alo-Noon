/**
 * The text of every message the system sends a customer, and the variables each
 * kind of message is allowed to use.
 *
 * This exists because message wording is the operator's business, not the
 * programmer's. "کد ورود شما" versus "رمز یکبار مصرف" is a decision a bakery
 * should be able to make on a Tuesday afternoon without a deploy, and the same
 * goes for how an order-ready message reads.
 *
 * What the operator must *not* be able to do is write `{amount}` into a message
 * that has no amount to give it. That would reach a real customer with a literal
 * `{amount}` in it. So each purpose declares its variables up front, and a body
 * is refused at write time if it names one the purpose cannot supply or omits
 * one it must. The declaration is also what the panel shows the operator, so the
 * list they see and the list enforced are the same list.
 */
import { DomainError } from './errors'

export const MESSAGE_CHANNELS = ['SMS'] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]

export const MESSAGE_TEMPLATE_PURPOSES = [
  'AUTH_OTP',
  'ORDER_ACCEPTED',
  'ORDER_REJECTED',
  'ORDER_READY',
  'ORDER_OUT_FOR_DELIVERY',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED',
] as const
export type MessageTemplatePurpose = (typeof MESSAGE_TEMPLATE_PURPOSES)[number]

export interface MessageTemplateVariable {
  readonly name: string
  /** A body missing a required variable is refused; the message would be useless without it. */
  readonly required: boolean
  /** Shown next to the field in the panel, so the operator knows what they are inserting. */
  readonly labelFa: string
  /** Stands in for the real value when previewing and when measuring length. */
  readonly example: string
}

export interface MessageTemplateDefinition {
  readonly purpose: MessageTemplatePurpose
  readonly labelFa: string
  readonly descriptionFa: string
  readonly variables: readonly MessageTemplateVariable[]
  /** What a tenant sends before anyone edits anything. */
  readonly defaultBody: string
}

const ORDER_CODE: MessageTemplateVariable = {
  name: 'orderCode',
  required: true,
  labelFa: 'کد سفارش',
  example: 'A7K2M9',
}
const CUSTOMER_NAME: MessageTemplateVariable = {
  name: 'customerName',
  required: false,
  labelFa: 'نام گیرنده',
  example: 'زهرا محمدی',
}
const BAKERY_NAME: MessageTemplateVariable = {
  name: 'bakeryName',
  required: false,
  labelFa: 'نام نانوایی',
  example: 'نان سنگک بابل',
}
const ORDER_TOTAL: MessageTemplateVariable = {
  name: 'total',
  required: false,
  labelFa: 'مبلغ سفارش (ریال)',
  example: '۱٬۸۵۰٬۰۰۰',
}
const REASON: MessageTemplateVariable = {
  name: 'reason',
  required: false,
  labelFa: 'دلیل',
  example: 'اتمام موجودی',
}

/**
 * Deliberately a fixed list rather than something operators can extend. A
 * purpose is a point in the code where a message is sent; inventing a purpose in
 * the panel would create a template nothing would ever render.
 */
export const MESSAGE_TEMPLATE_DEFINITIONS: readonly MessageTemplateDefinition[] = Object.freeze([
  {
    purpose: 'AUTH_OTP',
    labelFa: 'کد ورود یکبارمصرف',
    descriptionFa: 'هنگام ورود مشتری یا اپراتور به اپ و پنل فرستاده می‌شود.',
    variables: [
      { name: 'code', required: true, labelFa: 'کد ورود', example: '۰۰۴۲۳۱' },
      { name: 'minutes', required: false, labelFa: 'مدت اعتبار (دقیقه)', example: '۵' },
    ],
    defaultBody: 'کد ورود شما به الو نون: {code}',
  },
  {
    purpose: 'ORDER_ACCEPTED',
    labelFa: 'پذیرش سفارش',
    descriptionFa: 'وقتی نانوایی سفارش پرداخت‌شده را می‌پذیرد.',
    variables: [ORDER_CODE, CUSTOMER_NAME, BAKERY_NAME, ORDER_TOTAL],
    defaultBody: 'سفارش {orderCode} پذیرفته شد و به‌زودی آماده می‌شود. الو نون',
  },
  {
    purpose: 'ORDER_REJECTED',
    labelFa: 'رد سفارش',
    descriptionFa: 'وقتی نانوایی نمی‌تواند سفارش را انجام دهد. مبلغ برگشت می‌خورد.',
    variables: [ORDER_CODE, CUSTOMER_NAME, BAKERY_NAME, REASON],
    defaultBody: 'متأسفیم، سفارش {orderCode} انجام نشد و مبلغ آن برگشت داده می‌شود. الو نون',
  },
  {
    purpose: 'ORDER_READY',
    labelFa: 'آماده شدن سفارش',
    descriptionFa: 'وقتی پخت تمام شده و سفارش آمادهٔ تحویل است.',
    variables: [ORDER_CODE, CUSTOMER_NAME, BAKERY_NAME],
    defaultBody: 'سفارش {orderCode} آمادهٔ تحویل است. الو نون',
  },
  {
    purpose: 'ORDER_OUT_FOR_DELIVERY',
    labelFa: 'خروج برای تحویل',
    descriptionFa: 'وقتی سفارش به پیک تحویل داده می‌شود.',
    variables: [ORDER_CODE, CUSTOMER_NAME],
    defaultBody: 'سفارش {orderCode} تحویل پیک شد و در راه است. الو نون',
  },
  {
    purpose: 'ORDER_COMPLETED',
    labelFa: 'تحویل سفارش',
    descriptionFa: 'وقتی سفارش به دست مشتری رسیده است.',
    variables: [ORDER_CODE, CUSTOMER_NAME],
    defaultBody: 'سفارش {orderCode} تحویل شد. نوش جان! الو نون',
  },
  {
    purpose: 'ORDER_CANCELLED',
    labelFa: 'لغو سفارش',
    descriptionFa: 'وقتی سفارش لغو می‌شود. اگر پرداختی انجام شده باشد برگشت می‌خورد.',
    variables: [ORDER_CODE, CUSTOMER_NAME, REASON],
    defaultBody: 'سفارش {orderCode} لغو شد. اگر مبلغی پرداخت شده باشد برگشت می‌خورد. الو نون',
  },
])

export function messageTemplateDefinition(
  purpose: MessageTemplatePurpose,
): MessageTemplateDefinition {
  const definition = MESSAGE_TEMPLATE_DEFINITIONS.find((entry) => entry.purpose === purpose)
  if (!definition) {
    throw new DomainError(
      'MESSAGE_TEMPLATE_PURPOSE_UNKNOWN',
      `No message is defined for purpose ${purpose}`,
    )
  }
  return definition
}

export function isMessageTemplatePurpose(value: string): value is MessageTemplatePurpose {
  return (MESSAGE_TEMPLATE_PURPOSES as readonly string[]).includes(value)
}

/**
 * Long enough for a message that explains itself, short enough that nobody
 * writes an essay the tenant then pays to send several times a minute.
 */
export const MESSAGE_TEMPLATE_MAX_LENGTH = 480

/** `{name}` — the name is restricted so a stray `{` in prose is a clear error, not a variable. */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g

export type MessageTemplateProblem =
  | { readonly code: 'EMPTY_BODY' }
  | { readonly code: 'BODY_TOO_LONG'; readonly length: number }
  | { readonly code: 'UNKNOWN_VARIABLE'; readonly name: string }
  | { readonly code: 'MISSING_REQUIRED_VARIABLE'; readonly name: string }
  | { readonly code: 'MALFORMED_PLACEHOLDER' }

/**
 * Every reason a body would be refused, all at once.
 *
 * Returned as a list rather than thrown one at a time so the panel can show an
 * operator everything wrong with what they typed instead of making them
 * discover it a save at a time.
 */
export function validateMessageTemplateBody(
  purpose: MessageTemplatePurpose,
  body: string,
): readonly MessageTemplateProblem[] {
  const problems: MessageTemplateProblem[] = []
  const trimmed = body.trim()
  if (trimmed.length === 0) return [{ code: 'EMPTY_BODY' }]
  if (trimmed.length > MESSAGE_TEMPLATE_MAX_LENGTH) {
    problems.push({ code: 'BODY_TOO_LONG', length: trimmed.length })
  }

  const definition = messageTemplateDefinition(purpose)
  const declared = new Set(definition.variables.map((variable) => variable.name))
  const used = new Set<string>()
  for (const match of trimmed.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] as string
    used.add(name)
    if (!declared.has(name)) problems.push({ code: 'UNKNOWN_VARIABLE', name })
  }

  // A brace that survived the placeholder pass is a typo — `{ code}`, `{cod`,
  // `{order_code}`. Left alone it would be sent verbatim to a customer.
  if (/[{}]/.test(trimmed.replace(PLACEHOLDER_PATTERN, ''))) {
    problems.push({ code: 'MALFORMED_PLACEHOLDER' })
  }

  for (const variable of definition.variables) {
    if (variable.required && !used.has(variable.name)) {
      problems.push({ code: 'MISSING_REQUIRED_VARIABLE', name: variable.name })
    }
  }
  return problems
}

/**
 * Substitutes values into a body.
 *
 * A placeholder with no value is an empty string rather than the literal
 * `{name}`: by the time we are rendering, the body has already been validated
 * against the purpose, so a missing value means an optional variable the caller
 * had nothing for. Sending `سفارش شما از {bakeryName}` to a customer would be
 * worse than sending the sentence without the name.
 */
export function renderMessageTemplate(
  body: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  return body
    .replace(PLACEHOLDER_PATTERN, (_match, name: string) => values[name] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * What one message will cost to send, in billable parts.
 *
 * Persian text is not in the GSM alphabet, so carriers encode it as UCS-2: 70
 * UTF-16 units in a single message, 67 each once it has to be split and each
 * part carries a concatenation header. An operator adding a polite closing
 * sentence can double a tenant's SMS bill without any warning that they did, so
 * the panel shows this next to the body.
 */
export function smsSegments(text: string): number {
  const units = [...text].reduce((total, character) => {
    const code = character.codePointAt(0) ?? 0
    return total + (code > 0xffff ? 2 : 1)
  }, 0)
  if (units === 0) return 0
  return units <= 70 ? 1 : Math.ceil(units / 67)
}

/**
 * The body as a customer would receive it, with every variable filled by its
 * declared example.
 *
 * Used for the panel preview and for the segment count, so what the operator is
 * shown is produced by the same renderer that will produce the real message —
 * a preview computed a second way would eventually disagree with what is sent.
 */
export function previewMessageTemplate(purpose: MessageTemplatePurpose, body: string): string {
  const definition = messageTemplateDefinition(purpose)
  const values: Record<string, string> = {}
  for (const variable of definition.variables) values[variable.name] = variable.example
  return renderMessageTemplate(body, values)
}
