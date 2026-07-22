import { z } from "zod";

export const logisticsQuoteRequestSchema = z.object({
  cityCode: z.string().min(2).max(32),
  providerId: z.string().min(3).max(64).optional(),
  routeDistanceMeters: z.number().int().nonnegative(),
  routeDurationSeconds: z.number().int().nonnegative(),
  trafficMultiplier: z.number().min(1).max(2.5).default(1),
  demandMultiplier: z.number().min(1).max(2.5).default(1),
  itemCount: z.number().int().positive().max(100).default(1),
  isFreshSignatureOrder: z.boolean().default(false),
  requestedAt: z.string().datetime()
});

export type LogisticsQuoteRequest = z.infer<typeof logisticsQuoteRequestSchema>;

export type LogisticsQuote = {
  currency: "IRR";
  totalFee: number;
  validUntil: string;
  components: {
    baseFee: number;
    distanceFee: number;
    durationFee: number;
    trafficMultiplier: number;
    demandMultiplier: number;
    nightMultiplier: number;
    freshnessHandlingFee: number;
  };
  policyVersion: string;
};
