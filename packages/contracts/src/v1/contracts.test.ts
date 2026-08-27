import { describe, expect, it } from 'vitest'

import {
  addressInputSchema,
  addressCreateSchema,
  activeCitiesEnvelopeSchema,
  cartEnvelopeSchema,
  cartItemMutationSchema,
  catalogPageSchema,
  eventEnvelopeSchema,
  otpRequestEnvelopeSchema,
  otpRequestSchema,
  otpVerifySchema,
  quoteCreateSchema,
  quoteEnvelopeSchema,
  orderDraftInputSchema,
  orderCreateSchema,
  orderEnvelopeSchema,
  paymentCreatedEventPayloadSchema,
  paymentStateChangedEventPayloadSchema,
  financialTransactionPostedEventPayloadSchema,
  paymentSummarySchema,
  financialTransactionSummarySchema,
  serviceabilityEnvelopeSchema,
  serviceabilityRequestSchema,
  sessionEnvelopeSchema,
  sessionContextSchema,
} from './index'

const validAddress = {
  cityId: '719f89ae-84bf-4f57-83a6-573ffe0ac9c6',
  label: 'خانه',
  recipientName: 'مشتری آزمایشی',
  recipientPhone: '+981112345678',
  addressLine: 'بابل، نشانی توسعه غیرواقعی برای آزمون قرارداد',
  postalCode: '1234567890',
  latitude: 36.5387,
  longitude: 52.6765,
}

describe('v1 geography contracts', () => {
  it('validates a Babol-compatible address and serviceability request', () => {
    expect(addressInputSchema.parse(validAddress)).toEqual(validAddress)
    expect(
      serviceabilityRequestSchema.parse({
        cityId: validAddress.cityId,
        latitude: validAddress.latitude,
        longitude: validAddress.longitude,
      }),
    ).toBeDefined()
  })

  it('rejects invalid coordinates and Iranian phone formats', () => {
    expect(() => addressInputSchema.parse({ ...validAddress, latitude: 95 })).toThrow()
    expect(() =>
      addressInputSchema.parse({ ...validAddress, recipientPhone: '09110000000' }),
    ).toThrow()
  })

  it('accepts only server-derivable address commands', () => {
    const command = addressCreateSchema.parse({
      ...validAddress,
      idempotencyKey: 'address-command-0001',
      operationalZoneId: '11111111-1111-4111-8111-111111111111',
    })
    expect(command).not.toHaveProperty('operationalZoneId')
  })

  it('validates active-city and serviceability response envelopes', () => {
    const meta = {
      requestId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
      timestamp: '2026-07-29T12:00:00.000Z',
      version: 'v1',
    } as const
    expect(
      activeCitiesEnvelopeSchema.parse({
        success: true,
        data: [
          {
            id: validAddress.cityId,
            code: 'BABOL',
            nameFa: 'بابل',
            timezone: 'Asia/Tehran',
          },
        ],
        meta,
      }),
    ).toBeDefined()
    expect(
      serviceabilityEnvelopeSchema.parse({
        success: true,
        data: {
          serviceable: false,
          reason: 'OUTSIDE_SERVICE_AREA',
          evaluatedAt: meta.timestamp,
        },
        meta,
      }),
    ).toBeDefined()
  })
})

describe('v1 order and event contracts', () => {
  it('preserves caller price snapshots as integer strings', () => {
    const draft = orderDraftInputSchema.parse({
      idempotencyKey: 'order-command-12345678',
      customerId: '22048a68-8a9c-4775-b6b2-28e449f73220',
      bakeryBranchId: 'de56d615-8974-460b-b96c-8177ecb64214',
      deliveryAddress: validAddress,
      items: [
        {
          productVariantId: 'e42c44e3-f380-4544-875b-ec95f06f1ba2',
          bakeryProductOfferingId: '0434822f-4823-49ff-b91d-f540bdc2fb51',
          quantity: 2,
          expectedUnitPrice: { amount: '250000', currency: 'IRR' },
        },
      ],
    })
    expect(draft.items[0]?.expectedUnitPrice).toEqual({ amount: '250000', currency: 'IRR' })
  })

  it('validates versioned event envelopes', () => {
    expect(
      eventEnvelopeSchema.parse({
        eventId: 'a78150c0-0f5f-4f44-ae20-29eb63062322',
        name: 'order.created',
        version: 1,
        purpose: 'DOMAIN',
        occurredAt: '2026-07-25T08:30:00.000Z',
        actor: { type: 'SYSTEM' },
        subject: { type: 'order', id: '22048a68-8a9c-4775-b6b2-28e449f73220' },
        correlationId: 'bc8b4a51-6ca7-4f35-887e-f8903820fc7e',
        consentBasis: 'TRANSACTIONAL',
        payload: { state: 'DRAFT' },
      }),
    ).toBeDefined()
  })
})

describe('v1 payment and ledger foundation contracts', () => {
  const paymentId = 'cb1e8354-976a-456f-9a70-1d9b93b722ac'
  const orderId = '22048a68-8a9c-4775-b6b2-28e449f73220'
  const customerId = '0af09971-0ef8-4033-912d-238b68b8feb1'
  const transactionId = 'fefbfab1-4e5d-40e2-b930-661f55cbe529'

  it('validates payment and balanced-journal read models with integer strings', () => {
    expect(
      paymentSummarySchema.parse({
        id: paymentId,
        publicId: 'payment-public-01',
        orderId,
        customerId,
        state: 'CAPTURED',
        amount: { amount: '530000', currency: 'IRR' },
        version: 4,
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:03:00.000Z',
      }).amount.amount,
    ).toBe('530000')
    expect(
      financialTransactionSummarySchema.parse({
        id: transactionId,
        paymentId,
        orderId,
        type: 'PAYMENT_CAPTURE',
        amount: { amount: '530000', currency: 'IRR' },
        correlationId: 'bc8b4a51-6ca7-4f35-887e-f8903820fc7e',
        occurredAt: '2026-08-03T00:03:00.000Z',
        postedAt: '2026-08-03T00:03:00.000Z',
        entries: [
          {
            id: '1a16bbb6-35fd-434f-b990-b3e8b7b83c0b',
            accountId: 'c761bd1d-bfbf-4747-a78d-d558f1cd7cd2',
            accountCode: 'CASH',
            sequence: 1,
            side: 'DEBIT',
            amount: { amount: '530000', currency: 'IRR' },
          },
          {
            id: 'f1ac1f86-78dc-461e-a263-a360c3838c99',
            accountId: '0d1013f5-51df-4762-876f-c587be0cebe2',
            accountCode: 'PAYMENT_CLEARING',
            sequence: 2,
            side: 'CREDIT',
            amount: { amount: '530000', currency: 'IRR' },
          },
        ],
      }).entries,
    ).toHaveLength(2)
  })

  it('validates PII-free payment and posting events', () => {
    expect(
      paymentCreatedEventPayloadSchema.parse({
        paymentId,
        orderId,
        customerId,
        state: 'CREATED',
        amount: '530000',
        currency: 'IRR',
      }),
    ).toBeDefined()
    expect(
      paymentStateChangedEventPayloadSchema.parse({
        paymentId,
        orderId,
        fromState: 'AUTHORIZED',
        toState: 'CAPTURED',
        version: 4,
      }),
    ).toBeDefined()
    expect(
      financialTransactionPostedEventPayloadSchema.parse({
        financialTransactionId: transactionId,
        paymentId,
        orderId,
        type: 'PAYMENT_CAPTURE',
        amount: '530000',
        currency: 'IRR',
        entryCount: 2,
      }),
    ).toBeDefined()
  })

  it('rejects floating, signed, and non-IRR financial contracts', () => {
    const invalid = {
      id: paymentId,
      publicId: 'payment-public-01',
      orderId,
      customerId,
      state: 'CREATED',
      amount: { amount: '530.5', currency: 'IRR' },
      version: 1,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    }
    expect(() => paymentSummarySchema.parse(invalid)).toThrow()
    expect(() =>
      paymentSummarySchema.parse({ ...invalid, amount: { amount: '-1', currency: 'IRR' } }),
    ).toThrow()
    expect(() =>
      paymentSummarySchema.parse({ ...invalid, amount: { amount: '1', currency: 'USD' } }),
    ).toThrow()
  })
})

describe('v1 identity contracts', () => {
  it('accepts E.164 OTP input and a scoped session context', () => {
    expect(otpRequestSchema.parse({ mobileE164: '+989111234567' })).toEqual({
      mobileE164: '+989111234567',
    })
    expect(
      otpVerifySchema.parse({
        challengeId: '5ec50854-4e4f-4cb7-b51a-cabf39dfe26f',
        code: '004231',
      }),
    ).toBeDefined()
    expect(
      sessionContextSchema.parse({
        tenantId: '00000000-0000-4000-8000-000000000001',
        accountId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
        customerId: '0af09971-0ef8-4033-912d-238b68b8feb1',
        expiresAt: '2026-08-28T12:00:00.000Z',
        grants: [
          {
            roleCode: 'CUSTOMER',
            permissions: ['session.self.read'],
            scopeType: 'SELF',
            scopeId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
            expiresAt: null,
          },
        ],
      }),
    ).toBeDefined()
  })

  it('validates OTP and session success envelopes', () => {
    const meta = {
      requestId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
      timestamp: '2026-07-29T12:00:00.000Z',
      version: 'v1',
    } as const
    expect(
      otpRequestEnvelopeSchema.parse({
        success: true,
        data: {
          challengeId: '5ec50854-4e4f-4cb7-b51a-cabf39dfe26f',
          expiresAt: '2026-07-29T12:05:00.000Z',
          retryAfterSeconds: 60,
        },
        meta,
      }),
    ).toBeDefined()
    expect(
      sessionEnvelopeSchema.parse({
        success: true,
        data: {
          tenantId: '00000000-0000-4000-8000-000000000001',
          accountId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
          customerId: '0af09971-0ef8-4033-912d-238b68b8feb1',
          expiresAt: '2026-08-28T12:00:00.000Z',
          grants: [],
        },
        meta,
      }),
    ).toBeDefined()
  })

  it('rejects local phone formats and malformed OTP codes', () => {
    expect(() => otpRequestSchema.parse({ mobileE164: '09111234567' })).toThrow()
    expect(() =>
      otpVerifySchema.parse({
        challengeId: '5ec50854-4e4f-4cb7-b51a-cabf39dfe26f',
        code: '12345',
      }),
    ).toThrow()
  })
})

describe('v1 catalog response contracts', () => {
  it('validates a paginated catalog response', () => {
    expect(
      catalogPageSchema.parse({
        success: true,
        data: [
          {
            id: 'c787d489-c7f1-4677-8302-b0120fd35ff5',
            offeringId: '0d908503-5bd2-41e6-a627-b7165e3956e0',
            variantId: 'e42c44e3-f380-4544-875b-ec95f06f1ba2',
            sku: 'ALO-SIGNATURE-001',
            slug: 'barbari-vizhe',
            nameFa: 'بربری ویژه',
            categoryCode: 'BARBARI',
            categoryNameFa: 'بربری',
            fulfillmentClass: 'SIGNATURE_FRESH',
            freshnessClaim: 'FRESHLY_PRODUCED',
            price: { amount: '250000', currency: 'IRR' },
            operationalZoneId: '9f1b6a2c-1b2c-4d3e-8f4a-5b6c7d8e9f01',
            lifecycle: 'ACTIVE',
          },
        ],
        meta: {
          requestId: 'bde6b5bd-f377-493b-a6c0-71dc3837ad88',
          timestamp: '2026-07-29T12:00:00.000Z',
          version: 'v1',
          pagination: {
            page: 1,
            pageSize: 20,
            totalItems: 1,
            totalPages: 1,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        },
      }),
    ).toBeDefined()
  })
})

describe('v1 cart and quote contracts', () => {
  const item = {
    id: '11111111-1111-4111-8111-111111111111',
    bakeryProductOfferingId: '22222222-2222-4222-8222-222222222222',
    productVariantId: '33333333-3333-4333-8333-333333333333',
    bakeryBranchId: '44444444-4444-4444-8444-444444444444',
    sku: 'ALO-SIGNATURE-001',
    nameFa: 'بربری ویژه',
    fulfillmentClass: 'SIGNATURE_FRESH',
    freshnessClaim: 'FRESHLY_PRODUCED',
    quantity: 2,
    unitPrice: { amount: '250000', currency: 'IRR' },
    lineTotal: { amount: '500000', currency: 'IRR' },
  } as const
  const meta = {
    requestId: '55555555-5555-4555-8555-555555555555',
    timestamp: '2026-07-29T12:00:00.000Z',
    version: 'v1',
  } as const

  it('validates bounded mutations and idempotent quote commands', () => {
    expect(
      cartItemMutationSchema.parse({
        cityId: '66666666-6666-4666-8666-666666666666',
        operationalZoneId: '77777777-7777-4777-8777-777777777777',
        quantity: 2,
        expectedCartVersion: 1,
      }),
    ).toBeDefined()
    expect(() =>
      cartItemMutationSchema.parse({
        cityId: '66666666-6666-4666-8666-666666666666',
        operationalZoneId: '77777777-7777-4777-8777-777777777777',
        quantity: 101,
      }),
    ).toThrow()
    expect(
      quoteCreateSchema.parse({
        deliveryAddressId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedCartVersion: 1,
        idempotencyKey: 'quote-command-0001',
      }),
    ).toBeDefined()
  })

  it('validates server-calculated cart and immutable quote snapshots', () => {
    const cart = {
      id: '88888888-8888-4888-8888-888888888888',
      cityId: '66666666-6666-4666-8666-666666666666',
      operationalZoneId: '77777777-7777-4777-8777-777777777777',
      bakeryBranchId: item.bakeryBranchId,
      version: 1,
      subtotal: item.lineTotal,
      items: [item],
      updatedAt: meta.timestamp,
    }
    expect(cartEnvelopeSchema.parse({ success: true, data: cart, meta })).toBeDefined()
    expect(
      quoteEnvelopeSchema.parse({
        success: true,
        data: {
          id: '99999999-9999-4999-8999-999999999999',
          publicId: 'quote-public-001',
          cartId: cart.id,
          cartVersion: cart.version,
          status: 'ACTIVE',
          expiresAt: '2026-07-29T12:10:00.000Z',
          deliveryAddressId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          deliveryServiceAreaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          deliveryOperationalZoneId: cart.operationalZoneId,
          deliveryDistanceMeters: 1_250,
          deliveryPricingRuleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          deliveryPricingRuleVersion: 1,
          subtotal: item.lineTotal,
          deliveryFee: { amount: '0', currency: 'IRR' },
          discount: { amount: '0', currency: 'IRR' },
          total: item.lineTotal,
          items: [item],
          createdAt: meta.timestamp,
        },
        meta,
      }),
    ).toBeDefined()
  })

  it('keeps order creation limited to quote identity and idempotency', () => {
    const command = orderCreateSchema.parse({
      quoteId: '99999999-9999-4999-8999-999999999999',
      idempotencyKey: 'order-command-0001',
      totalAmount: '1',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    expect(command).toEqual({
      quoteId: '99999999-9999-4999-8999-999999999999',
      idempotencyKey: 'order-command-0001',
    })
    expect(() => orderEnvelopeSchema.parse({ success: true, data: { total: 1 }, meta })).toThrow()
  })
})
