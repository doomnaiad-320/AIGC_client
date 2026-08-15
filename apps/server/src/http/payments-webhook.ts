// @credits-system — Lemon Squeezy webhook handler: subscription events, payment confirmation
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AdminDbClient } from "../db/client.js";
import type {
  PaymentService,
  WebhookPayload,
} from "../features/payments/payment-service.js";

export async function registerPaymentWebhookRoute(
  app: FastifyInstance,
  options: {
    getAdminClient: () => AdminDbClient;
    paymentService: PaymentService;
    webhookSecret: string;
  },
) {
  // Register a custom content-type parser to capture the raw body for
  // HMAC signature verification while still parsing JSON.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post("/api/payments/webhook", async (request, reply) => {
    const rawBody = request.body as string;
    const receivedAt = new Date().toISOString();

    // ── 1. Verify webhook signature ──────────────────────────
    const signature = request.headers["x-signature"] as string | undefined;
    if (!signature) {
      return reply.code(401).send({ error: "Missing X-Signature header" });
    }

    const expected = crypto
      .createHmac("sha256", options.webhookSecret)
      .update(rawBody)
      .digest("hex");

    const receivedSignature = Buffer.from(signature, "utf8");
    const expectedSignature = Buffer.from(expected, "utf8");
    if (
      receivedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    // ── 2. Parse body ────────────────────────────────────────
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      return reply.code(400).send({ error: "Invalid JSON body" });
    }

    const eventName = payload.meta?.event_name;
    if (!eventName) {
      return reply.code(400).send({ error: "Missing meta.event_name" });
    }

    const workspaceId = payload.meta?.custom_data?.workspace_id ?? null;

    // Lemon Squeezy's payload resource id identifies the subscription, not the
    // delivery. Hashing the signed raw body gives retries a stable event id.
    const admin = options.getAdminClient();
    const providerEventId = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");
    const { data: claimRows, error: claimError } = await admin.query<{
      result: {
        attemptCount: number;
        claimed: boolean;
        eventId: string;
        status: "failed" | "processed" | "processing";
      };
    }>(
      `select public.payment_claim_webhook_event(
         $1::text, $2::text, $3::text, $4::text, $5::uuid, $6::jsonb
       ) as result`,
      [
        "lemon_squeezy",
        providerEventId,
        eventName,
        payload.data?.id ?? null,
        workspaceId,
        JSON.stringify(payload),
      ],
    );
    const claim = claimRows?.[0]?.result;
    if (claimError || !claim) {
      request.log.error(
        { error: claimError?.message, providerEventId },
        "Failed to claim payment webhook",
      );
      return reply.code(503).send({ error: "Webhook processing unavailable" });
    }
    if (!claim.claimed) {
      return reply.code(200).send({
        duplicate: true,
        received: true,
        status: claim.status,
      });
    }

    // Subscription projection, credit grant and processed state commit in one
    // PostgreSQL transaction inside the payment service RPC.
    try {
      await options.paymentService.handleWebhookEvent(eventName, payload, {
        providerEventId,
        receivedAt,
      });
    } catch (processingError) {
      const errorMessage =
        processingError instanceof Error
          ? processingError.message
          : "Unknown error";

      request.log.error(
        { error: errorMessage, eventName, providerEventId },
        "Payment webhook processing failed",
      );
      const { error: failError } = await admin.query(
        `select public.payment_fail_webhook_event(
           $1::text, $2::text, $3::text
         ) as result`,
        ["lemon_squeezy", providerEventId, errorMessage],
      );
      if (failError) {
        request.log.error(
          { error: failError.message, providerEventId },
          "Failed to mark payment webhook as failed",
        );
      }

      return reply.code(503).send({
        error: "Webhook processing failed",
        retryable: true,
      });
    }

    return reply.code(200).send({ received: true });
  });
}
