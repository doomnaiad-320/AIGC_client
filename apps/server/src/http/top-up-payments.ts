import {
  applicationErrorResponseSchema,
  topUpCheckoutRequestSchema,
  topUpCheckoutResponseSchema,
  topUpOrderStatusSchema,
  topUpPackSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type TopUpPaymentService,
  TopUpPaymentServiceError,
} from "../features/payments/top-up-payment-service.js";

const orderParamsSchema = z.object({ orderId: z.string().uuid() });

export async function registerTopUpPaymentRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    paymentService: TopUpPaymentService;
    viewerService: ViewerService;
    webOrigin: string;
  },
) {
  app.get("/api/payments/top-up-packs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const packs = await options.paymentService.listPacks(viewer.workspace.id);
      return reply.code(200).send({
        packs: packs.map((pack) => topUpPackSchema.parse(pack)),
      });
    } catch (error) {
      return sendTopUpError(error, reply);
    }
  });

  app.post("/api/payments/top-up-checkout", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const input = topUpCheckoutRequestSchema.parse(request.body);
      const checkout = await options.paymentService.createCheckout(
        viewer.workspace.id,
        user.id,
        input,
        request.ip,
      );
      return reply.code(200).send(topUpCheckoutResponseSchema.parse(checkout));
    } catch (error) {
      return sendTopUpError(error, reply);
    }
  });

  app.get("/api/payments/top-up-orders/:orderId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const params = orderParamsSchema.parse(request.params);
      const order = await options.paymentService.getOrderStatus(
        viewer.workspace.id,
        params.orderId,
      );
      return reply.code(200).send(topUpOrderStatusSchema.parse(order));
    } catch (error) {
      return sendTopUpError(error, reply);
    }
  });

  app.get("/api/payments/dulupay/notify", async (request, reply) => {
    try {
      await options.paymentService.processDuluPayCallback(
        normalizeQuery(request.query),
      );
      return reply.type("text/plain; charset=utf-8").code(200).send("success");
    } catch (error) {
      request.log.warn({ err: error }, "Rejected DuluPay notification");
      return reply.type("text/plain; charset=utf-8").code(400).send("fail");
    }
  });

  app.get("/api/payments/dulupay/return", async (request, reply) => {
    const query = normalizeQuery(request.query);
    const orderId = String(query.out_trade_no ?? "");
    try {
      await options.paymentService.processDuluPayCallback(query);
      return reply.redirect(
        `${options.webOrigin}/settings?tab=billing&topup=success&order=${encodeURIComponent(orderId)}`,
      );
    } catch (error) {
      request.log.warn({ err: error }, "Rejected DuluPay return callback");
      return reply.redirect(
        `${options.webOrigin}/settings?tab=billing&topup=failed&order=${encodeURIComponent(orderId)}`,
      );
    }
  });
}

function normalizeQuery(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendTopUpError(error: unknown, reply: FastifyReply) {
  if (error instanceof TopUpPaymentServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send(
      applicationErrorResponseSchema.parse({
        error: { code: "invalid_request", message: "Invalid request." },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "top_up_checkout_failed",
        message: "Unable to process the top-up request.",
      },
    }),
  );
}
