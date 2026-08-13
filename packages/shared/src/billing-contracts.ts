import { z } from "zod";

import {
  billingPlanCodeSchema,
  billingPlanEntitlementsSchema,
} from "./admin-contracts.js";

export const publishedBillingPlanSchema = z.object({
  code: billingPlanCodeSchema,
  nameZh: z.string().min(1).max(100),
  descriptionZh: z.string().max(500),
  currency: z.literal("USD"),
  monthlyPriceMinor: z.number().int().nonnegative(),
  annualPriceMinor: z.number().int().nonnegative(),
  monthlySubscriptionCredits: z.number().int().nonnegative(),
  dailyCredits: z.number().int().nonnegative(),
  topUpEligible: z.boolean(),
  entitlements: billingPlanEntitlementsSchema,
});
export type PublishedBillingPlan = z.infer<typeof publishedBillingPlanSchema>;
