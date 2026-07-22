import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { ulid } from "ulid";
import { logisticsQuoteRequestSchema } from "./modules/logistics/domain.js";
import { calculateDeliveryQuote } from "./modules/logistics/pricing.js";

export function buildApp() {
  const app = Fastify({
    logger: true,
    genReqId: () => ulid()
  });

  app.register(helmet);
  app.register(cors, { origin: false });

  app.get("/health", async () => ({
    status: "ok",
    service: "alo-noon-api",
    version: "0.1.0"
  }));

  app.get("/api/v1/meta", async () => ({
    platform: "Alo Noon",
    apiVersion: "v1",
    launchCity: "Babol",
    architecture: "API-first",
    status: "foundation"
  }));

  app.post("/api/v1/logistics/quotes", async (request, reply) => {
    const parsed = logisticsQuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "Invalid logistics quote request.",
        details: parsed.error.flatten()
      });
    }

    return reply.code(200).send(calculateDeliveryQuote(parsed.data));
  });

  return app;
}
