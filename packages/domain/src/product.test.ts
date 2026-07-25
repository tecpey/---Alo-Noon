import { describe, expect, it } from 'vitest'

import { DomainError } from './errors'
import {
  FreshnessClaim,
  FulfillmentControl,
  ProductFulfillmentClass,
  ProductionMode,
  validateProductClassification,
  type ProductClassification,
} from './product'

const validCases: ProductClassification[] = [
  {
    fulfillmentClass: ProductFulfillmentClass.SIGNATURE_FRESH,
    freshnessClaim: FreshnessClaim.FRESHLY_PRODUCED,
    productionMode: ProductionMode.MADE_TO_ORDER,
    fulfillmentControl: FulfillmentControl.CONTROLLED_PICKUP,
    freshnessPolicy: {
      productionWindowMinutes: 30,
      pickupWithinMinutes: 15,
      freshnessWindowMinutes: 90,
    },
  },
  {
    fulfillmentClass: ProductFulfillmentClass.PACKAGED_TRADITIONAL,
    freshnessClaim: FreshnessClaim.PACKAGED,
    productionMode: ProductionMode.READY_STOCK,
    fulfillmentControl: FulfillmentControl.PLATFORM_STOCK,
    packagingPolicy: { type: 'ALO_NOON_SEALED', shelfLifeMinutes: 1_440 },
  },
]

describe('product classification policy', () => {
  it.each(validCases)('accepts valid product combinations', (classification) => {
    expect(validateProductClassification(classification)).toEqual(classification)
  })

  it.each([
    {
      fulfillmentClass: ProductFulfillmentClass.PACKAGED_TRADITIONAL,
      freshnessClaim: FreshnessClaim.FRESHLY_PRODUCED,
      productionMode: ProductionMode.READY_STOCK,
      fulfillmentControl: FulfillmentControl.PLATFORM_STOCK,
    },
    {
      fulfillmentClass: ProductFulfillmentClass.SIGNATURE_FRESH,
      freshnessClaim: FreshnessClaim.FRESHLY_PRODUCED,
      productionMode: ProductionMode.MADE_TO_ORDER,
      fulfillmentControl: FulfillmentControl.CONTROLLED_PICKUP,
    },
  ] as ProductClassification[])(
    'rejects misleading or incomplete combinations',
    (classification) => {
      expect(() => validateProductClassification(classification)).toThrowError(DomainError)
    },
  )
})
