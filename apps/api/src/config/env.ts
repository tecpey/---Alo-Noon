import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  DELIVERY_BASE_FEE_IRR: z.coerce.number().nonnegative().default(500_000),
  DELIVERY_PER_KM_IRR: z.coerce.number().nonnegative().default(120_000),
  DELIVERY_PER_MINUTE_IRR: z.coerce.number().nonnegative().default(12_000),
  DELIVERY_NIGHT_MULTIPLIER: z.coerce.number().min(1).default(1.2),
  DELIVERY_MAX_SURGE_MULTIPLIER: z.coerce.number().min(1).default(1.8)
});

export const env = envSchema.parse(process.env);
