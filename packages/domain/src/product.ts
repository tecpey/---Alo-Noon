import { DomainError } from './errors'

export const ProductFulfillmentClass = {
  SIGNATURE_FRESH: 'SIGNATURE_FRESH',
  PACKAGED_TRADITIONAL: 'PACKAGED_TRADITIONAL',
  PACKAGED_FANTASY: 'PACKAGED_FANTASY',
  PACKAGED_DIETARY: 'PACKAGED_DIETARY',
  LIMITED_EDITION: 'LIMITED_EDITION',
} as const
export type ProductFulfillmentClass =
  (typeof ProductFulfillmentClass)[keyof typeof ProductFulfillmentClass]

export const FreshnessClaim = {
  FRESHLY_PRODUCED: 'FRESHLY_PRODUCED',
  PACKAGED: 'PACKAGED',
  SHELF_STABLE: 'SHELF_STABLE',
  NONE: 'NONE',
} as const
export type FreshnessClaim = (typeof FreshnessClaim)[keyof typeof FreshnessClaim]

export const ProductionMode = {
  MADE_TO_ORDER: 'MADE_TO_ORDER',
  SCHEDULED_BATCH: 'SCHEDULED_BATCH',
  READY_STOCK: 'READY_STOCK',
  EXTERNAL_PACKAGED_SUPPLY: 'EXTERNAL_PACKAGED_SUPPLY',
} as const
export type ProductionMode = (typeof ProductionMode)[keyof typeof ProductionMode]

export const FulfillmentControl = {
  CONTROLLED_PICKUP: 'CONTROLLED_PICKUP',
  PARTNER_HANDOFF: 'PARTNER_HANDOFF',
  PLATFORM_STOCK: 'PLATFORM_STOCK',
  THIRD_PARTY_SUPPLY: 'THIRD_PARTY_SUPPLY',
} as const
export type FulfillmentControl = (typeof FulfillmentControl)[keyof typeof FulfillmentControl]

export interface PackagingPolicy {
  type: 'ALO_NOON_SEALED' | 'PARTNER_SEALED' | 'MANUFACTURER_PACKAGED'
  shelfLifeMinutes: number
}

export interface FreshnessPolicy {
  productionWindowMinutes: number
  pickupWithinMinutes: number
  freshnessWindowMinutes: number
}

export interface ProductClassification {
  fulfillmentClass: ProductFulfillmentClass
  freshnessClaim: FreshnessClaim
  productionMode: ProductionMode
  fulfillmentControl: FulfillmentControl
  freshnessPolicy?: FreshnessPolicy
  packagingPolicy?: PackagingPolicy
}

export function validateProductClassification(
  input: ProductClassification,
): Readonly<ProductClassification> {
  const issues: string[] = []
  const isSignature = input.fulfillmentClass === ProductFulfillmentClass.SIGNATURE_FRESH
  const isFreshClaim = input.freshnessClaim === FreshnessClaim.FRESHLY_PRODUCED
  const packagedClasses: readonly ProductFulfillmentClass[] = [
    ProductFulfillmentClass.PACKAGED_TRADITIONAL,
    ProductFulfillmentClass.PACKAGED_FANTASY,
    ProductFulfillmentClass.PACKAGED_DIETARY,
  ]
  const isPackagedClass = packagedClasses.includes(input.fulfillmentClass)

  if (isFreshClaim && !isSignature) {
    issues.push('Only SIGNATURE_FRESH products may claim FRESHLY_PRODUCED')
  }
  if (isSignature && !isFreshClaim) {
    issues.push('SIGNATURE_FRESH products must use the FRESHLY_PRODUCED claim')
  }
  if (isFreshClaim && !input.freshnessPolicy) {
    issues.push('Freshly produced products require production, pickup, and freshness windows')
  }
  if (
    input.freshnessPolicy &&
    Object.values(input.freshnessPolicy).some((minutes) => !isPositiveInteger(minutes))
  ) {
    issues.push('Freshness windows must be positive integer minutes')
  }
  if (
    isSignature &&
    !(<readonly ProductionMode[]>[
      ProductionMode.MADE_TO_ORDER,
      ProductionMode.SCHEDULED_BATCH,
    ]).includes(input.productionMode)
  ) {
    issues.push('SIGNATURE_FRESH production must be MADE_TO_ORDER or SCHEDULED_BATCH')
  }
  if (
    isSignature &&
    !(<readonly FulfillmentControl[]>[
      FulfillmentControl.CONTROLLED_PICKUP,
      FulfillmentControl.PARTNER_HANDOFF,
    ]).includes(input.fulfillmentControl)
  ) {
    issues.push('SIGNATURE_FRESH fulfillment requires controlled pickup or partner handoff')
  }
  if (isPackagedClass && isFreshClaim) {
    issues.push('Packaged product classes cannot use a freshly produced claim')
  }
  if (isPackagedClass && !input.packagingPolicy) {
    issues.push('Packaged product classes require packaging and shelf-life information')
  }
  if (input.packagingPolicy && !isPositiveInteger(input.packagingPolicy.shelfLifeMinutes)) {
    issues.push('Packaged shelf life must be positive integer minutes')
  }
  if (
    isPackagedClass &&
    !(<readonly FreshnessClaim[]>[FreshnessClaim.PACKAGED, FreshnessClaim.SHELF_STABLE]).includes(
      input.freshnessClaim,
    )
  ) {
    issues.push('Packaged product classes must use PACKAGED or SHELF_STABLE claims')
  }
  if (input.fulfillmentClass === ProductFulfillmentClass.LIMITED_EDITION && isFreshClaim) {
    issues.push('LIMITED_EDITION fresh claims require a future governance decision')
  }

  if (issues.length > 0) {
    throw new DomainError(
      'INVALID_PRODUCT_CLASSIFICATION',
      'Product classification violates Alo Noon catalog rules',
      { issues },
    )
  }
  return Object.freeze(input)
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
