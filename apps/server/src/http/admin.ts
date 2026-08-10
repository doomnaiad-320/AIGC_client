import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminAgentRunSchema,
  adminAuditEventSchema,
  adminCreditAdjustmentRequestSchema,
  adminCreditAdjustmentResponseSchema,
  adminCreditTransactionSchema,
  adminJobSchema,
  adminOverviewSchema,
  adminUserDetailSchema,
  adminUserSchema,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { RequestAuthenticator } from "../auth/user.js";
import {
  type PlatformAdminService,
  PlatformAdminServiceError,
} from "../features/admin/platform-admin-service.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(32).optional(),
});

const userParamsSchema = z.object({
  userId: z.string().uuid(),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    adminService: PlatformAdminService;
  },
) {
  app.get("/api/admin/me", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);

    try {
      const isPlatformAdmin = await options.adminService.isPlatformAdmin(
        user.id,
      );
      return reply.code(200).send({ isPlatformAdmin });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/overview", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const overview = await options.adminService.getOverview();
      return reply
        .code(200)
        .send({ overview: adminOverviewSchema.parse(overview) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/users", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = listQuerySchema.parse(request.query);
      const users = await options.adminService.listUsers({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
      });
      return reply
        .code(200)
        .send({ users: users.map((user) => adminUserSchema.parse(user)) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/users/:userId", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const params = userParamsSchema.parse(request.params);
      const detail = await options.adminService.getUserDetail(params.userId);
      return reply
        .code(200)
        .send({ detail: adminUserDetailSchema.parse(detail) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/jobs", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = listQuerySchema.parse(request.query);
      const jobs = await options.adminService.listJobs({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      });
      return reply
        .code(200)
        .send({ jobs: jobs.map((job) => adminJobSchema.parse(job)) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/agent-runs", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = listQuerySchema.parse(request.query);
      const runs = await options.adminService.listAgentRuns({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      });
      return reply
        .code(200)
        .send({ runs: runs.map((run) => adminAgentRunSchema.parse(run)) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/credit-transactions", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = listQuerySchema.parse(request.query);
      const transactions = await options.adminService.listTransactions(
        query.limit !== undefined ? { limit: query.limit } : {},
      );
      return reply.code(200).send({
        transactions: transactions.map((transaction) =>
          adminCreditTransactionSchema.parse(transaction),
        ),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/audit-events", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = listQuerySchema.parse(request.query);
      const events = await options.adminService.listAuditEvents(
        query.limit !== undefined ? { limit: query.limit } : {},
      );
      return reply.code(200).send({
        events: events.map((event) => adminAuditEventSchema.parse(event)),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.post("/api/admin/credit-adjustments", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const input = adminCreditAdjustmentRequestSchema.parse(request.body);
      const adjustment = await options.adminService.adjustCredits(
        user.id,
        input,
      );
      return reply
        .code(200)
        .send(adminCreditAdjustmentResponseSchema.parse(adjustment));
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });
}

async function requirePlatformAdmin(
  request: Parameters<RequestAuthenticator["authenticate"]>[0],
  reply: FastifyReply,
  options: { auth: RequestAuthenticator; adminService: PlatformAdminService },
) {
  const user = await options.auth.authenticate(request);
  if (!user) {
    sendUnauthorized(reply);
    return null;
  }
  if (!(await options.adminService.isPlatformAdmin(user.id))) {
    reply.code(403).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "platform_admin_required",
          message: "Platform administrator access is required.",
        },
      }),
    );
    return null;
  }
  return user;
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

function sendAdminError(error: unknown, reply: FastifyReply) {
  if (reply.sent) return;
  if (error instanceof PlatformAdminServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof z.ZodError) {
    return reply
      .code(400)
      .send({ issues: error.issues, message: "Invalid request" });
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "admin_query_failed",
        message: "Unable to complete admin request.",
      },
    }),
  );
}
