import { describe, expect, it, vi } from "vitest";

import type { AdminDbClient } from "../../db/client.js";
import { createLocalSubscriptionService } from "./local-subscription-service.js";
import { PaymentServiceError } from "./payment-service.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "11111111-1111-4111-8111-111111111111";

function makeAdminClient(
  query = vi.fn().mockResolvedValue({ data: [{ result: {} }], error: null }),
) {
  return { query } as unknown as AdminDbClient;
}

describe("local subscription service", () => {
  it("activates paid plans through the PostgreSQL lifecycle function", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ data: [{ result: { action: "activated" } }], error: null });
    const service = createLocalSubscriptionService({
      getAdminClient: () => makeAdminClient(query),
      webOrigin: "http://localhost:3000",
    });

    const result = await service.createCheckout(
      workspaceId,
      actorUserId,
      "team",
      "yearly",
    );

    expect(result).toEqual({
      activated: true,
      checkoutUrl:
        "http://localhost:3000/settings?tab=billing&subscription=activated",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "billing_local_activate_subscription",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      workspaceId,
      actorUserId,
      "team",
      "yearly",
      expect.stringMatching(/^local:/),
    ]);
  });

  it("uses dedicated database functions for status, cancellation and resume", async () => {
    const status = {
      billingPeriod: "monthly",
      canceledAt: null,
      cancelAtPeriodEnd: false,
      creditPeriodEnd: null,
      creditPeriodStart: null,
      currency: "USD",
      currentPeriodEnd: null,
      currentPeriodStart: null,
      customerPortalUrl: null,
      lemonSqueezySubscriptionId: null,
      monthlyCredits: 5000,
      plan: "pro",
      planName: "专业版",
      provider: "local",
      status: "active",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ result: status }], error: null })
      .mockResolvedValue({ data: [{ result: { success: true } }], error: null });
    const service = createLocalSubscriptionService({
      getAdminClient: () => makeAdminClient(query),
      webOrigin: "http://localhost:3000",
    });

    await expect(
      service.getSubscriptionStatus(workspaceId, actorUserId),
    ).resolves.toEqual(status);
    await service.cancelSubscription(workspaceId, actorUserId);
    await service.resumeSubscription(workspaceId, actorUserId);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("billing_local_get_subscription_status"),
      expect.stringContaining("billing_local_cancel_subscription"),
      expect.stringContaining("billing_local_resume_subscription"),
    ]);
  });

  it("maps workspace authorization failures to a protected API error", async () => {
    const query = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "SUBSCRIPTION_WORKSPACE_ADMIN_REQUIRED" },
    });
    const service = createLocalSubscriptionService({
      getAdminClient: () => makeAdminClient(query),
      webOrigin: "http://localhost:3000",
    });

    await expect(
      service.cancelSubscription(workspaceId, actorUserId),
    ).rejects.toMatchObject({
      code: "subscription_update_failed",
      statusCode: 403,
    } satisfies Partial<PaymentServiceError>);
  });
});
