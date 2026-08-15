import { describe, expect, it, vi } from "vitest";

import type { AdminDbClient } from "../../db/client.js";
import type { LemonSqueezyClient } from "./lemon-squeezy-client.js";
import { createPaymentService } from "./payment-service.js";

describe("Lemon Squeezy payment service", () => {
  it("delegates subscription projection and credit grants to one PostgreSQL function", async () => {
    const query = vi.fn().mockResolvedValue({
      data: [{ result: { processed: true } }],
      error: null,
    });
    const service = createPaymentService({
      getAdminClient: () => ({ query }) as unknown as AdminDbClient,
      lemonSqueezy: {} as LemonSqueezyClient,
      variantMap: { pro_monthly: "456" },
      webOrigin: "http://localhost:3000",
    });
    const payload = {
      meta: {
        custom_data: {
          workspace_id: "22222222-2222-4222-8222-222222222222",
        },
        event_name: "subscription_payment_success",
      },
      data: {
        attributes: {
          customer_id: 12,
          ends_at: null,
          order_id: 34,
          renews_at: "2026-09-14T00:00:00.000Z",
          status: "active",
          store_id: 1,
          updated_at: "2026-08-14T00:00:00.000Z",
          variant_id: 456,
        },
        id: "subscription-123",
        type: "subscriptions",
      },
    };

    await service.handleWebhookEvent("subscription_payment_success", payload, {
      providerEventId: "provider-event-hash",
      receivedAt: "2026-08-14T00:00:01.000Z",
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "billing_process_lemon_squeezy_webhook",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      "provider-event-hash",
      "subscription_payment_success",
      "22222222-2222-4222-8222-222222222222",
      "subscription-123",
      "12",
      "456",
      "34",
      "pro",
      "monthly",
      "active",
      "2026-08-14T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
      false,
      null,
      JSON.stringify(payload),
    ]);
  });

  it("reads subscription status from the canonical billing projection", async () => {
    const query = vi.fn().mockResolvedValue({
      data: [
        {
          billingPeriod: "monthly",
          canceledAt: null,
          cancelAtPeriodEnd: false,
          creditPeriodEnd: "2026-09-14T00:00:00.000Z",
          creditPeriodStart: "2026-08-14T00:00:00.000Z",
          currentPeriodEnd: "2026-09-14T00:00:00.000Z",
          currentPeriodStart: "2026-08-14T00:00:00.000Z",
          monthlyCredits: 5000,
          plan: "pro",
          planName: "专业版",
          provider: "lemon_squeezy",
          providerSubscriptionId: "subscription-123",
          status: "active",
        },
      ],
      error: null,
    });
    const getSubscription = vi.fn().mockResolvedValue({
      attributes: {
        urls: { customer_portal: "https://billing.example.test/portal" },
      },
    });
    const service = createPaymentService({
      getAdminClient: () => ({ query }) as unknown as AdminDbClient,
      lemonSqueezy: { getSubscription } as unknown as LemonSqueezyClient,
      variantMap: { pro_monthly: "456" },
      webOrigin: "http://localhost:3000",
    });

    await expect(
      service.getSubscriptionStatus(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({
      billingPeriod: "monthly",
      canceledAt: null,
      cancelAtPeriodEnd: false,
      creditPeriodEnd: "2026-09-14T00:00:00.000Z",
      creditPeriodStart: "2026-08-14T00:00:00.000Z",
      currency: "USD",
      currentPeriodEnd: "2026-09-14T00:00:00.000Z",
      currentPeriodStart: "2026-08-14T00:00:00.000Z",
      customerPortalUrl: "https://billing.example.test/portal",
      lemonSqueezySubscriptionId: "subscription-123",
      monthlyCredits: 5000,
      plan: "pro",
      planName: "专业版",
      provider: "lemon_squeezy",
      status: "active",
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "workspace_billing_subscriptions",
    );
    expect(getSubscription).toHaveBeenCalledWith("subscription-123");
  });

  it("surfaces database failures so the webhook endpoint can request a retry", async () => {
    const query = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "PAYMENT_PLAN_VERSION_UNAVAILABLE" },
    });
    const service = createPaymentService({
      getAdminClient: () => ({ query }) as unknown as AdminDbClient,
      lemonSqueezy: {} as LemonSqueezyClient,
      variantMap: {},
      webOrigin: "http://localhost:3000",
    });

    await expect(
      service.handleWebhookEvent(
        "subscription_created",
        {
          meta: { event_name: "subscription_created" },
          data: {
            attributes: {
              customer_id: 12,
              ends_at: null,
              order_id: 34,
              renews_at: "2026-09-14T00:00:00.000Z",
              status: "active",
              store_id: 1,
              variant_id: 999,
            },
            id: "subscription-123",
            type: "subscriptions",
          },
        },
        {
          providerEventId: "provider-event-hash",
          receivedAt: "2026-08-14T00:00:01.000Z",
        },
      ),
    ).rejects.toMatchObject({
      code: "webhook_processing_failed",
      message: "PAYMENT_PLAN_VERSION_UNAVAILABLE",
    });
  });
});
