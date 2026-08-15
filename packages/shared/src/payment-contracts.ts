import { z } from "zod";

import { paymentMethodSchema } from "./admin-contracts.js";

export const topUpPackSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  credits: z.number().int().positive(),
  currency: z.literal("USD"),
  priceMinor: z.number().int().positive(),
  minimumPlanCode: z.enum(["pro", "team"]),
  provider: z.literal("dulupay"),
  providerCurrency: z.literal("CNY"),
  providerAmountMinor: z.number().int().positive(),
  paymentMethods: z.array(paymentMethodSchema).min(1),
});
export type TopUpPack = z.infer<typeof topUpPackSchema>;

export const topUpCheckoutRequestSchema = z.object({
  packCode: z.string().trim().min(1).max(50),
  paymentMethod: paymentMethodSchema,
  idempotencyKey: z.string().uuid(),
  device: z.enum(["pc", "mobile", "qq", "wechat", "alipay"]).default("pc"),
});
export type TopUpCheckoutRequest = z.infer<typeof topUpCheckoutRequestSchema>;

export const topUpCheckoutResponseSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum(["pending", "paid"]),
  payType: z.string(),
  payInfo: z.string(),
  providerTradeNo: z.string(),
});
export type TopUpCheckoutResponse = z.infer<typeof topUpCheckoutResponseSchema>;

export const topUpOrderStatusSchema = z.object({
  orderId: z.string().uuid(),
  status: z.enum([
    "pending",
    "paid",
    "failed",
    "refunded",
    "partially_refunded",
    "canceled",
  ]),
  credits: z.number().int().positive(),
  paidAt: z.string().datetime().nullable(),
});
export type TopUpOrderStatus = z.infer<typeof topUpOrderStatusSchema>;
