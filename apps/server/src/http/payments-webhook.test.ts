import crypto from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AdminDbClient } from "../db/client.js";
import type { PaymentService } from "../features/payments/payment-service.js";
import { registerPaymentWebhookRoute } from "./payments-webhook.js";

const secret = "webhook-test-secret";
const workspaceId = "22222222-2222-4222-8222-222222222222";

const payload = {
  meta: {
    custom_data: { workspace_id: workspaceId },
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
      variant_id: 56,
    },
    id: "subscription-123",
    type: "subscriptions",
  },
};

function signature(rawBody: string) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function paymentService(
  handleWebhookEvent = vi.fn().mockResolvedValue(undefined),
): PaymentService {
  return {
    cancelSubscription: vi.fn(),
    changePlan: vi.fn(),
    createCheckout: vi.fn(),
    getSubscriptionStatus: vi.fn(),
    handleWebhookEvent,
    resumeSubscription: vi.fn(),
  };
}

async function makeApp(options?: {
  handleWebhookEvent?: ReturnType<typeof vi.fn>;
  query?: ReturnType<typeof vi.fn>;
}) {
  const query =
    options?.query ??
    vi.fn().mockResolvedValue({
      data: [
        {
          result: {
            attemptCount: 1,
            claimed: true,
            eventId: "event-row-id",
            status: "processing",
          },
        },
      ],
      error: null,
    });
  const service = paymentService(options?.handleWebhookEvent);
  const app = Fastify();
  await registerPaymentWebhookRoute(app, {
    getAdminClient: () => ({ query }) as unknown as AdminDbClient,
    paymentService: service,
    webhookSecret: secret,
  });
  return { app, query, service };
}

describe("payment webhook", () => {
  it("rejects malformed signatures without throwing", async () => {
    const { app, query, service } = await makeApp();
    const rawBody = JSON.stringify(payload);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-signature": "short",
      },
      method: "POST",
      payload: rawBody,
      url: "/api/payments/webhook",
    });

    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(service.handleWebhookEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it("claims the body hash before processing the webhook", async () => {
    const { app, query, service } = await makeApp();
    const rawBody = JSON.stringify(payload);
    const providerEventId = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-signature": signature(rawBody),
      },
      method: "POST",
      payload: rawBody,
      url: "/api/payments/webhook",
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain("payment_claim_webhook_event");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "lemon_squeezy",
      providerEventId,
      "subscription_payment_success",
      "subscription-123",
      workspaceId,
      rawBody,
    ]);
    expect(service.handleWebhookEvent).toHaveBeenCalledWith(
      "subscription_payment_success",
      payload,
      expect.objectContaining({ providerEventId }),
    );
    await app.close();
  });

  it("acknowledges an already claimed or processed delivery without rerunning it", async () => {
    const query = vi.fn().mockResolvedValue({
      data: [
        {
          result: {
            attemptCount: 1,
            claimed: false,
            eventId: "event-row-id",
            status: "processed",
          },
        },
      ],
      error: null,
    });
    const { app, service } = await makeApp({ query });
    const rawBody = JSON.stringify(payload);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-signature": signature(rawBody),
      },
      method: "POST",
      payload: rawBody,
      url: "/api/payments/webhook",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duplicate: true,
      status: "processed",
    });
    expect(service.handleWebhookEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it("marks processing failures as retryable and returns 503", async () => {
    const handleWebhookEvent = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            result: {
              attemptCount: 1,
              claimed: true,
              eventId: "event-row-id",
              status: "processing",
            },
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ result: true }], error: null });
    const { app } = await makeApp({ handleWebhookEvent, query });
    const rawBody = JSON.stringify(payload);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-signature": signature(rawBody),
      },
      method: "POST",
      payload: rawBody,
      url: "/api/payments/webhook",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ retryable: true });
    expect(query.mock.calls[1]?.[0]).toContain("payment_fail_webhook_event");
    await app.close();
  });
});
