import { describe, expect, it } from 'vitest'

import {
  MESSAGE_TEMPLATE_DEFINITIONS,
  MESSAGE_TEMPLATE_MAX_LENGTH,
  previewMessageTemplate,
  renderMessageTemplate,
  smsSegments,
  validateMessageTemplateBody,
} from './message-template'

describe('message template validation', () => {
  it('refuses a variable the purpose cannot supply', () => {
    // The failure this prevents is a customer receiving the literal text
    // `{amount}` because nothing on the OTP path has an amount to give it.
    expect(validateMessageTemplateBody('AUTH_OTP', 'کد {code} مبلغ {amount}')).toContainEqual({
      code: 'UNKNOWN_VARIABLE',
      name: 'amount',
    })
  })

  it('refuses a body that drops a variable the message is useless without', () => {
    expect(validateMessageTemplateBody('AUTH_OTP', 'برای ورود کد را وارد کنید')).toEqual([
      { code: 'MISSING_REQUIRED_VARIABLE', name: 'code' },
    ])
  })

  it('reports every problem at once rather than one save at a time', () => {
    const problems = validateMessageTemplateBody('ORDER_READY', 'سفارش {amount} از {shop}')
    expect(problems).toEqual([
      { code: 'UNKNOWN_VARIABLE', name: 'amount' },
      { code: 'UNKNOWN_VARIABLE', name: 'shop' },
      { code: 'MISSING_REQUIRED_VARIABLE', name: 'orderCode' },
    ])
  })

  it('catches a brace that is not a placeholder at all', () => {
    // `{ code}` and `{order_code}` do not match the placeholder pattern, so
    // without this check they would be sent to a customer verbatim.
    for (const body of ['کد { code}', 'کد {code} و {order_code}', 'کد {code']) {
      expect(validateMessageTemplateBody('AUTH_OTP', body)).toContainEqual({
        code: 'MALFORMED_PLACEHOLDER',
      })
    }
  })

  it('refuses an empty body without piling on other complaints', () => {
    expect(validateMessageTemplateBody('AUTH_OTP', '   ')).toEqual([{ code: 'EMPTY_BODY' }])
  })

  it('bounds the length, because every part is paid for', () => {
    const body = `{code} ${'ن'.repeat(MESSAGE_TEMPLATE_MAX_LENGTH)}`
    expect(validateMessageTemplateBody('AUTH_OTP', body)).toContainEqual({
      code: 'BODY_TOO_LONG',
      length: body.trim().length,
    })
  })

  it('accepts every shipped default', () => {
    // A default that failed its own validation would leave a tenant unable to
    // save the template the system already sends.
    for (const definition of MESSAGE_TEMPLATE_DEFINITIONS) {
      expect(validateMessageTemplateBody(definition.purpose, definition.defaultBody)).toEqual([])
    }
  })
})

describe('rendering', () => {
  it('substitutes every occurrence', () => {
    expect(renderMessageTemplate('{code} — {code}', { code: '004231' })).toBe('004231 — 004231')
  })

  it('drops an optional variable rather than leaving a placeholder in the message', () => {
    expect(renderMessageTemplate('سفارش {orderCode} از {bakeryName}', { orderCode: 'A7' })).toBe(
      'سفارش A7 از',
    )
  })

  it('never leaves a brace in what a customer receives', () => {
    for (const definition of MESSAGE_TEMPLATE_DEFINITIONS) {
      expect(previewMessageTemplate(definition.purpose, definition.defaultBody)).not.toMatch(/[{}]/)
    }
  })
})

describe('sms segments', () => {
  it('counts Persian text as UCS-2, which is what the carrier bills', () => {
    expect(smsSegments('')).toBe(0)
    expect(smsSegments('ن'.repeat(70))).toBe(1)
    // One character past the single-message limit costs two parts, not one and
    // a bit — and each part is then only 67 characters.
    expect(smsSegments('ن'.repeat(71))).toBe(2)
    expect(smsSegments('ن'.repeat(134))).toBe(2)
    expect(smsSegments('ن'.repeat(135))).toBe(3)
  })

  it('counts an emoji as the two units it actually occupies', () => {
    expect(smsSegments('🍞'.repeat(35))).toBe(1)
    expect(smsSegments('🍞'.repeat(36))).toBe(2)
  })

  it('keeps every shipped default to a single paid message', () => {
    for (const definition of MESSAGE_TEMPLATE_DEFINITIONS) {
      expect(smsSegments(previewMessageTemplate(definition.purpose, definition.defaultBody))).toBe(
        1,
      )
    }
  })
})
