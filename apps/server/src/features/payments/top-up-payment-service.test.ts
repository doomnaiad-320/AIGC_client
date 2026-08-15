import { describe, expect, it, vi } from "vitest";

import type { AdminDbClient } from "../../db/client.js";
import { createPaymentCredentialCrypto } from "./payment-credential-crypto.js";
import {
  type TopUpPaymentServiceError,
  createTopUpPaymentService,
} from "./top-up-payment-service.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "11111111-1111-4111-8111-111111111111";

function makeAdminClient(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as AdminDbClient;
}

describe("top-up payment service", () => {
  it("returns only the published catalog projection with USD and CNY amounts", async () => {
    const query = vi.fn().mockResolvedValue({
      data: [
        {
          code: "credits_5000",
          credits: 5000,
          description: "Permanent credits",
          minimumPlanCode: "pro",
          name: "5,000 credits",
          paymentMethods: ["alipay", "wxpay"],
          priceMinor: 999,
          providerAmountMinor: 6900,
        },
      ],
      error: null,
    });
    const service = createTopUpPaymentService({
      credentialCrypto: createPaymentCredentialCrypto("test-secret"),
      getAdminClient: () => makeAdminClient(query),
      serverPublicUrl: "https://api.example.com",
      webOrigin: "https://app.example.com",
    });

    await expect(service.listPacks(workspaceId)).resolves.toEqual([
      {
        code: "credits_5000",
        credits: 5000,
        currency: "USD",
        description: "Permanent credits",
        minimumPlanCode: "pro",
        name: "5,000 credits",
        paymentMethods: ["alipay", "wxpay"],
        priceMinor: 999,
        provider: "dulupay",
        providerAmountMinor: 6900,
        providerCurrency: "CNY",
      },
    ]);
  });

  it("rejects a disabled payment method before creating an order", async () => {
    const crypto = createPaymentCredentialCrypto("test-secret");
    const query = vi.fn().mockResolvedValue({
      data: [
        {
          allowedMethods: ["alipay"],
          apiBaseUrl: "https://api.dulupay.com/api",
          callbackToleranceSeconds: 300,
          enabled: true,
          merchantId: "merchant-1",
          merchantPrivateKeyCiphertext: crypto.encrypt("not-used-in-this-test"),
          platformPublicKey: "not-used-in-this-test",
        },
      ],
      error: null,
    });
    const service = createTopUpPaymentService({
      credentialCrypto: crypto,
      getAdminClient: () => makeAdminClient(query),
      serverPublicUrl: "https://api.example.com",
      webOrigin: "https://app.example.com",
    });

    await expect(
      service.createCheckout(
        workspaceId,
        actorUserId,
        {
          packCode: "credits_5000",
          paymentMethod: "wxpay",
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          device: "pc",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "payment_provider_unavailable",
      statusCode: 400,
    } satisfies Partial<TopUpPaymentServiceError>);
    expect(query).toHaveBeenCalledOnce();
  });
});
