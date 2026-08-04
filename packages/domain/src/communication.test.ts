import { describe, expect, it } from 'vitest'

import {
  activateTemplateVersion,
  approveTemplateVersion,
  archiveTemplateVersion,
  createProviderTemplateBinding,
  createTemplateVersion,
  renderTemplate,
  submitTemplateForReview,
} from './communication'

const baseSms = () =>
  createTemplateVersion({
    id: 'version-1',
    templateId: 'auth-otp',
    version: 1,
    channel: 'SMS',
    locale: 'fa-IR',
    purpose: 'AUTH_OTP',
    body: 'کد ورود الو نون: {{otp}}',
    variables: [{ name: 'otp', type: 'STRING', required: true, maxLength: 6 }],
    createdByActorId: 'editor-1',
  })

describe('communication template governance', () => {
  it('creates immutable draft versions and rejects undeclared variables', () => {
    expect(baseSms()).toMatchObject({ status: 'DRAFT', subject: null, version: 1 })
    expect(() =>
      createTemplateVersion({
        id: 'version-2',
        templateId: 'auth-otp',
        version: 2,
        channel: 'SMS',
        locale: 'fa-IR',
        purpose: 'AUTH_OTP',
        body: 'کد: {{unknown}}',
        variables: [],
        createdByActorId: 'editor-1',
      }),
    ).toThrow('undeclared variable')
  })

  it('enforces review and creator/approver segregation', () => {
    const review = submitTemplateForReview(baseSms())
    expect(review.status).toBe('IN_REVIEW')
    expect(() => approveTemplateVersion(review, 'editor-1', new Date())).toThrow('cannot approve')
    const approved = approveTemplateVersion(review, 'approver-1', new Date('2026-08-04T00:00:00Z'))
    expect(approved).toMatchObject({
      status: 'APPROVED',
      reviewedByActorId: 'approver-1',
    })
    expect(activateTemplateVersion(approved).status).toBe('ACTIVE')
  })

  it('blocks invalid lifecycle transitions', () => {
    expect(() => activateTemplateVersion(baseSms())).toThrow('not allowed')
    expect(() => archiveTemplateVersion(baseSms())).toThrow('not allowed')
  })

  it('renders only approved versions with strict typed variables', () => {
    const approved = approveTemplateVersion(
      submitTemplateForReview(baseSms()),
      'approver-1',
      new Date(),
    )
    expect(renderTemplate(approved, { otp: '123456' })).toEqual({
      subject: null,
      body: 'کد ورود الو نون: 123456',
    })
    expect(() => renderTemplate(approved, {})).toThrow('Required template variable')
    expect(() => renderTemplate(approved, { otp: '123456', extra: 'leak' })).toThrow(
      'Unknown template variable',
    )
    expect(() => renderTemplate(approved, { otp: '1234567' })).toThrow('variable is invalid')
  })

  it('requires email subject and HTTPS URL variables', () => {
    const draft = createTemplateVersion({
      id: 'version-email-1',
      templateId: 'order-ready',
      version: 1,
      channel: 'EMAIL',
      locale: 'fa-IR',
      purpose: 'ORDER_STATUS',
      subject: 'سفارش {{orderNumber}} آماده شد',
      body: 'جزئیات: {{detailsUrl}}',
      variables: [
        { name: 'orderNumber', type: 'STRING', required: true, maxLength: 30 },
        { name: 'detailsUrl', type: 'URL', required: true, maxLength: 500 },
      ],
      createdByActorId: 'editor-2',
    })
    const approved = approveTemplateVersion(
      submitTemplateForReview(draft),
      'approver-2',
      new Date(),
    )
    expect(
      renderTemplate(approved, {
        orderNumber: 'AN-1001',
        detailsUrl: 'https://alo-noon.example/orders/AN-1001',
      }).subject,
    ).toBe('سفارش AN-1001 آماده شد')
    expect(() =>
      renderTemplate(approved, {
        orderNumber: 'AN-1001',
        detailsUrl: 'http://unsafe.example/orders/AN-1001',
      }),
    ).toThrow('variable is invalid')
  })

  it('validates provider pattern bindings without coupling to a vendor', () => {
    expect(
      createProviderTemplateBinding({
        id: 'binding-1',
        templateVersionId: 'version-1',
        providerCode: 'IR_SMS',
        providerTemplateReference: 'otp-login-v1',
        enabled: true,
      }),
    ).toMatchObject({
      providerCode: 'IR_SMS',
      providerTemplateReference: 'otp-login-v1',
    })
    expect(() =>
      createProviderTemplateBinding({
        id: 'binding-2',
        templateVersionId: 'version-1',
        providerCode: 'limoo sms',
        providerTemplateReference: 'otp-login-v1',
        enabled: true,
      }),
    ).toThrow('Provider code is invalid')
  })
})
