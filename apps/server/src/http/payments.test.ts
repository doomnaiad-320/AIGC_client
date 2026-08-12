import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerPaymentUnavailableRoutes } from "./payments.js";

describe("payment unavailable routes", () => {
  it("returns a clear service-unavailable error when payments are not configured", async () => {
    const app = Fastify();
    await registerPaymentUnavailableRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/checkout",
      payload: { billingPeriod: "monthly", plan: "pro" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "payment_not_configured" },
    });
    await app.close();
  });
});
