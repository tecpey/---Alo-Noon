import { describe, expect, it } from 'vitest'

import {
  addressInputSchema,
  eventEnvelopeSchema,
  orderDraftInputSchema,
  serviceabilityRequestSchema,
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
