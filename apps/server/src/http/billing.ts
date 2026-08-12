import type { FastifyInstance } from "fastify";

import { publishedBillingPlanSchema } from "@loomic/shared";

import type { BillingCatalogService } from "../features/billing/billing-catalog-service.js";

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: { billingCatalogService: BillingCatalogService },
) {
  app.get("/api/billing/plans", async (_request, reply) => {
    const plans = await options.billingCatalogService.listPublishedPlans();
    return reply.code(200).send({
      plans: plans.map((plan) => publishedBillingPlanSchema.parse(plan)),
    });
  });
}
