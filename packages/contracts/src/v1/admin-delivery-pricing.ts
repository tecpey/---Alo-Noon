import { z } from 'zod'

import { responseMetaSchema, uuidSchema } from './common'

/**
 * Governing what a delivery costs and what may carry it.
 *
 * Three settings that decided real money and real refusals before any of them
 * had a screen: the tariff a vehicle is priced on, the point past which a city
 * stops sending motorcycles, and whether an outlying area takes them at all.
 *
 * Money crosses as a decimal string throughout. Rial amounts run past what a
 * JSON number holds exactly, and a fare that rounds in transit is a fare nobody
 * can reconcile against the ledger that recorded it.
 */

const rialAmountSchema = z
  .string()
  .regex(/^\d{1,18}$/)
  .describe('A whole number of Rial, as a string.')

export const vehicleProfileSchema = z.enum(['MOTORCYCLE', 'CAR'])
export const pricingModeSchema = z.enum(['FLAT', 'DISTANCE_BANDED'])

export const adminDeliveryTariffSchema = z.object({
  id: uuidSchema,
  cityId: uuidSchema,
  cityNameFa: z.string().min(1),
  operationalZoneId: uuidSchema.nullable(),
  operationalZoneNameFa: z.string().min(1).nullable(),
  vehicleProfile: vehicleProfileSchema,
  version: z.number().int().min(1),
  calculationMode: pricingModeSchema,
  baseFeeAmount: rialAmountSchema,
  perKilometerFeeAmount: rialAmountSchema,
  minimumOrderAmount: rialAmountSchema.nullable(),
  freeDeliveryThreshold: rialAmountSchema.nullable(),
  effectiveFrom: z.string().datetime({ offset: true }),
  effectiveUntil: z.string().datetime({ offset: true }).nullable(),
  isActive: z.boolean(),
})
export type AdminDeliveryTariff = z.infer<typeof adminDeliveryTariffSchema>

export const adminDeliveryAreaSchema = z.object({
  id: uuidSchema,
  nameFa: z.string().min(1),
  code: z.string().min(1).max(32),
  operationalZoneId: uuidSchema,
  operationalZoneNameFa: z.string().min(1),
  motorcycleAllowed: z.boolean(),
  isActive: z.boolean(),
})
export type AdminDeliveryArea = z.infer<typeof adminDeliveryAreaSchema>

export const adminDeliveryCitySchema = z.object({
  id: uuidSchema,
  nameFa: z.string().min(1),
  /**
   * Null means nobody has measured this city — distinct from a tenant having
   * chosen a number that happens to equal the default, so a later correction to
   * the defaults moves the unmeasured cities and leaves the measured ones.
   */
  motorcycleItemLimit: z.number().int().min(1).nullable(),
  motorcycleRangeMetres: z.number().int().min(1).nullable(),
  /** What the quote path uses today, defaults filled in. */
  effectiveItemLimit: z.number().int().min(1),
  effectiveRangeMetres: z.number().int().min(1),
  /**
   * Whether a car can be quoted here at all. Shown beside the thresholds
   * because they are read together: a tight range produces car orders, and a
   * city with no car tariff refuses every one of them.
   */
  hasActiveCarTariff: z.boolean(),
  areas: z.array(adminDeliveryAreaSchema),
})
export type AdminDeliveryCity = z.infer<typeof adminDeliveryCitySchema>

export const publishDeliveryTariffCommandSchema = z
  .object({
    cityId: uuidSchema,
    /** Absent means the city-wide tariff, the fallback for zones with none. */
    operationalZoneId: uuidSchema.optional(),
    vehicleProfile: vehicleProfileSchema,
    calculationMode: pricingModeSchema,
    baseFeeAmount: rialAmountSchema,
    perKilometerFeeAmount: rialAmountSchema,
    minimumOrderAmount: rialAmountSchema.optional(),
    freeDeliveryThreshold: rialAmountSchema.optional(),
  })
  .superRefine((value, context) => {
    // A distance tariff charging nothing per kilometre is a flat tariff wearing
    // the wrong label: it prices every journey identically while appearing to
    // charge for distance, which is the kind of wrong that survives review.
    if (value.calculationMode === 'DISTANCE_BANDED' && BigInt(value.perKilometerFeeAmount) <= 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['perKilometerFeeAmount'],
        message: 'A distance tariff needs a per-kilometre rate above zero.',
      })
    }
    // Free delivery below the minimum order is unreachable: the order is
    // refused before the threshold can apply.
    if (
      value.freeDeliveryThreshold !== undefined &&
      value.minimumOrderAmount !== undefined &&
      BigInt(value.freeDeliveryThreshold) < BigInt(value.minimumOrderAmount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeDeliveryThreshold'],
        message: 'Free delivery cannot start below the minimum order amount.',
      })
    }
  })
export type PublishDeliveryTariffCommand = z.infer<typeof publishDeliveryTariffCommandSchema>

export const setCityVehicleThresholdsCommandSchema = z.object({
  /** Null clears the measurement and returns the city to the default. */
  motorcycleItemLimit: z.number().int().min(1).nullable(),
  motorcycleRangeMetres: z.number().int().min(1).nullable(),
})
export type SetCityVehicleThresholdsCommand = z.infer<typeof setCityVehicleThresholdsCommandSchema>

export const setAreaMotorcycleCommandSchema = z.object({
  motorcycleAllowed: z.boolean(),
})
export type SetAreaMotorcycleCommand = z.infer<typeof setAreaMotorcycleCommandSchema>

export const adminDeliveryCitiesEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(adminDeliveryCitySchema),
  meta: responseMetaSchema,
})
export const adminDeliveryCityEnvelopeSchema = z.object({
  success: z.literal(true),
  data: adminDeliveryCitySchema,
  meta: responseMetaSchema,
})
export const adminDeliveryTariffsEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.array(adminDeliveryTariffSchema),
  meta: responseMetaSchema,
})
export const adminDeliveryTariffEnvelopeSchema = z.object({
  success: z.literal(true),
  data: adminDeliveryTariffSchema,
  meta: responseMetaSchema,
})
export const adminDeliveryAreaEnvelopeSchema = z.object({
  success: z.literal(true),
  data: adminDeliveryAreaSchema,
  meta: responseMetaSchema,
})
