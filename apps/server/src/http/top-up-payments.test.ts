import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { TopUpPaymentService } from "../features/payments/top-up-payment-service.js";
import { registerTopUpPaymentRoutes } from "./top-up-payments.js";

const user = {
  accessToken: "token",
  authVersion: 0,
  email: "owner@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};
const workspaceId = "22222222-2222-4222-8222-222222222222";

function makeService(): TopUpPaymentService {
  return {
    listPacks: vi.fn().mockResolvedValue([]),
    createCheckout: vi.fn().mockResolvedValue({
      orderId: "33333333-3333-4333-8333-333333333333",
      status: "pending",
      payType: "jump",
      payInfo: "https://cashier.dulupay.com/pay/demo",
      providerTradeNo: "trade-1",
    }),
    getOrderStatus: vi.fn().mockResolvedValue({
      orderId: "33333333-3333-4333-8333-333333333333",
      status: "paid",
      credits: 5000,
      paidAt: "2026-08-16T00:00:00.000Z",
    }),
    processDuluPayCallback: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeApp(options?: {
  authenticated?: boolean;
  service?: TopUpPaymentService;
}) {
  const app = Fastify();
  const auth: RequestAuthenticator = {
    authenticate: vi
      .fn()
      .mockResolvedValue(options?.authenticated === false ? null : user),
  };
  const viewerService = {
    ensureViewer: vi.fn().mockResolvedValue({ workspace: { id: workspaceId } }),
  } as unknown as ViewerService;
  await registerTopUpPaymentRoutes(app, {
    auth,
    paymentService: options?.service ?? makeService(),
    viewerService,
    webOrigin: "http://localhost:3000",
  });
  return app;
}

describe("top-up payment routes", () => {
  it("protects the point-pack catalog with authentication", async () => {
    const app = await makeApp({ authenticated: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/payments/top-up-packs",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates checkout orders for the authenticated workspace", async () => {
    const service = makeService();
    const app = await makeApp({ service });
    const payload = {
      packCode: "credits_5000",
      paymentMethod: "alipay",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      device: "pc",
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/top-up-checkout",
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(service.createCheckout).toHaveBeenCalledWith(
      workspaceId,
      user.id,
      payload,
      expect.any(String),
    );
    await app.close();
  });

  it("returns the exact success acknowledgement required by DuluPay", async () => {
    const service = makeService();
    const app = await makeApp({ service });
    const response = await app.inject({
      method: "GET",
      url: "/api/payments/dulupay/notify?trade_status=TRADE_SUCCESS&sign=signed",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("success");
    expect(service.processDuluPayCallback).toHaveBeenCalledWith({
      sign: "signed",
      trade_status: "TRADE_SUCCESS",
    });
    await app.close();
  });
});
