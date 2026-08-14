import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { PaymentService } from "../features/payments/payment-service.js";
import {
  registerPaymentRoutes,
  registerPaymentUnavailableRoutes,
} from "./payments.js";

const user = {
  accessToken: "test-token",
  authVersion: 0,
  email: "owner@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};

const workspaceId = "22222222-2222-4222-8222-222222222222";

function makeViewerService(): ViewerService {
  return {
    ensureViewer: vi.fn().mockResolvedValue({
      membership: {
        role: "owner",
        userId: user.id,
        workspaceId,
      },
      profile: {
        displayName: "Owner",
        email: user.email,
        id: user.id,
      },
      workspace: {
        id: workspaceId,
        name: "Owner Workspace",
        ownerUserId: user.id,
        type: "personal",
      },
    }),
  };
}

function makePaymentService(): PaymentService {
  return {
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    changePlan: vi.fn().mockResolvedValue(undefined),
    createCheckout: vi.fn().mockResolvedValue({
      activated: true,
      checkoutUrl: null,
    }),
    getSubscriptionStatus: vi.fn().mockResolvedValue({
      billingPeriod: "monthly",
      canceledAt: null,
      cancelAtPeriodEnd: false,
      creditPeriodEnd: "2026-09-14T00:00:00.000Z",
      creditPeriodStart: "2026-08-14T00:00:00.000Z",
      currency: "USD",
      currentPeriodEnd: "2026-09-14T00:00:00.000Z",
      currentPeriodStart: "2026-08-14T00:00:00.000Z",
      customerPortalUrl: null,
      lemonSqueezySubscriptionId: null,
      monthlyCredits: 5000,
      plan: "pro",
      planName: "专业版",
      provider: "local",
      status: "active",
    }),
    handleWebhookEvent: vi.fn().mockResolvedValue(undefined),
    resumeSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeApp(
  paymentService: PaymentService,
  auth: RequestAuthenticator = {
    authenticate: vi.fn().mockResolvedValue(user),
  },
) {
  const app = Fastify();
  await registerPaymentRoutes(app, {
    auth,
    paymentService,
    viewerService: makeViewerService(),
  });
  return app;
}

describe("payment routes", () => {
  it("activates a canonical Team plan and passes the authenticated actor", async () => {
    const service = makePaymentService();
    const app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/checkout",
      payload: { billingPeriod: "yearly", plan: "team" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activated: true, checkoutUrl: null });
    expect(service.createCheckout).toHaveBeenCalledWith(
      workspaceId,
      user.id,
      "team",
      "yearly",
    );
    await app.close();
  });

  it("rejects legacy public plan codes", async () => {
    const service = makePaymentService();
    const app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/checkout",
      payload: { billingPeriod: "monthly", plan: "ultra" },
    });

    expect(response.statusCode).toBe(400);
    expect(service.createCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects checkout activation for the Free plan", async () => {
    const service = makePaymentService();
    const app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/payments/checkout",
      payload: { billingPeriod: "monthly", plan: "free" },
    });

    expect(response.statusCode).toBe(400);
    expect(service.createCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the authenticated actor to status, cancel, resume and plan changes", async () => {
    const service = makePaymentService();
    const app = await makeApp(service);

    expect(
      (await app.inject({ method: "GET", url: "/api/payments/subscription" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/api/payments/cancel" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/api/payments/resume" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/payments/change-plan",
          payload: { billingPeriod: "monthly", plan: "enterprise" },
        })
      ).statusCode,
    ).toBe(200);

    expect(service.getSubscriptionStatus).toHaveBeenCalledWith(
      workspaceId,
      user.id,
    );
    expect(service.cancelSubscription).toHaveBeenCalledWith(
      workspaceId,
      user.id,
    );
    expect(service.resumeSubscription).toHaveBeenCalledWith(
      workspaceId,
      user.id,
    );
    expect(service.changePlan).toHaveBeenCalledWith(
      workspaceId,
      user.id,
      "enterprise",
      "monthly",
    );
    await app.close();
  });

  it("rejects requests without an authenticated session", async () => {
    const service = makePaymentService();
    const app = await makeApp(service, {
      authenticate: vi.fn().mockResolvedValue(null),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/payments/subscription",
    });

    expect(response.statusCode).toBe(401);
    expect(service.getSubscriptionStatus).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("payment unavailable routes", () => {
  it.each([
    ["POST", "/api/payments/checkout"],
    ["GET", "/api/payments/subscription"],
    ["POST", "/api/payments/cancel"],
    ["POST", "/api/payments/resume"],
    ["POST", "/api/payments/change-plan"],
  ] as const)("returns 503 for %s %s", async (method, url) => {
    const app = Fastify();
    await registerPaymentUnavailableRoutes(app);

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "payment_not_configured" },
    });
    await app.close();
  });
});
