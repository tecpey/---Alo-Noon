import { env } from "../../config/env.js";
import type { LogisticsQuote, LogisticsQuoteRequest } from "./domain.js";

const roundIrr = (value: number): number => Math.round(value / 10_000) * 10_000;

export function calculateDeliveryQuote(input: LogisticsQuoteRequest): LogisticsQuote {
  const requestedAt = new Date(input.requestedAt);
  const hour = requestedAt.getUTCHours();
  const isNight = hour >= 18 || hour < 3;

  const baseFee = env.DELIVERY_BASE_FEE_IRR;
  const distanceFee = (input.routeDistanceMeters / 1000) * env.DELIVERY_PER_KM_IRR;
  const durationFee = (input.routeDurationSeconds / 60) * env.DELIVERY_PER_MINUTE_IRR;
  const nightMultiplier = isNight ? env.DELIVERY_NIGHT_MULTIPLIER : 1;
  const freshnessHandlingFee = input.isFreshSignatureOrder ? 100_000 : 0;
  const surge = Math.min(
    input.trafficMultiplier * input.demandMultiplier * nightMultiplier,
    env.DELIVERY_MAX_SURGE_MULTIPLIER
  );

  const totalFee = roundIrr((baseFee + distanceFee + durationFee) * surge + freshnessHandlingFee);
  const validUntil = new Date(requestedAt.getTime() + 5 * 60 * 1000).toISOString();

  return {
    currency: "IRR",
    totalFee,
    validUntil,
    components: {
      baseFee: roundIrr(baseFee),
      distanceFee: roundIrr(distanceFee),
      durationFee: roundIrr(durationFee),
      trafficMultiplier: input.trafficMultiplier,
      demandMultiplier: input.demandMultiplier,
      nightMultiplier,
      freshnessHandlingFee
    },
    policyVersion: "babol-pilot-v0.1"
  };
}
