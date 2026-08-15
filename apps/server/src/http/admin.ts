import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminAgentRunSchema,
  adminAuditEventSchema,
  adminBillingOverviewSchema,
  adminBillingPlanMutationSchema,
  adminBillingPlanSchema,
  adminCreditAdjustmentRequestSchema,
  adminCreditAdjustmentResponseSchema,
  adminCreditTransactionSchema,
  adminJobSchema,
  adminOverviewSchema,
  adminPasswordResetRequestSchema,
  adminPasswordResetResponseSchema,
  adminPaymentProviderConfigSchema,
  adminPlatformAdminMutationRequestSchema,
  adminPlatformAdminSchema,
  adminSaveTopUpPackDraftSchema,
  adminTopUpPackSchema,
  adminUpdateBillingPlanDraftSchema,
  adminUpdatePaymentProviderConfigSchema,
  adminUpdateUserRequestSchema,
  adminUpdateUserStatusRequestSchema,
  adminUserDetailSchema,
  adminUserSchema,
  adminWorkspaceDetailSchema,
  adminWorkspaceSchema,
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

const workspaceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(120).optional(),
  type: z.enum(["personal", "team"]).optional(),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const billingPlanParamsSchema = z.object({
  planCode: z.enum(["free", "pro", "team", "enterprise"]),
});

const topUpPackParamsSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/),
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
        ...(query.status !== undefined ? { status: query.status } : {}),
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

  app.get("/api/admin/workspaces", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const query = workspaceListQuerySchema.parse(request.query);
      const workspaces = await options.adminService.listWorkspaces({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
      });
      return reply.code(200).send({
        workspaces: workspaces.map((workspace) =>
          adminWorkspaceSchema.parse(workspace),
        ),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.get("/api/admin/workspaces/:workspaceId", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const params = workspaceParamsSchema.parse(request.params);
      const detail = await options.adminService.getWorkspaceDetail(
        params.workspaceId,
      );
      return reply
        .code(200)
        .send({ detail: adminWorkspaceDetailSchema.parse(detail) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.patch("/api/admin/users/:userId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, reply, options);
      if (!actor) return;
      const params = userParamsSchema.parse(request.params);
      const input = adminUpdateUserRequestSchema.parse(request.body);
      const detail = await options.adminService.updateUser(
        actor.id,
        params.userId,
        input,
      );
      return reply
        .code(200)
        .send({ detail: adminUserDetailSchema.parse(detail) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.patch("/api/admin/users/:userId/status", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, reply, options);
      if (!actor) return;
      const params = userParamsSchema.parse(request.params);
      const input = adminUpdateUserStatusRequestSchema.parse(request.body);
      const detail = await options.adminService.updateUserStatus(
        actor.id,
        params.userId,
        input,
      );
      return reply
        .code(200)
        .send({ detail: adminUserDetailSchema.parse(detail) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.post(
    "/api/admin/users/:userId/password-reset",
    async (request, reply) => {
      try {
        const actor = await requirePlatformAdmin(request, reply, options);
        if (!actor) return;
        const params = userParamsSchema.parse(request.params);
        const input = adminPasswordResetRequestSchema.parse(request.body);
        const result = await options.adminService.createPasswordReset(
          actor.id,
          params.userId,
          input,
        );
        return reply
          .code(201)
          .send(adminPasswordResetResponseSchema.parse(result));
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );

  app.get("/api/admin/platform-admins", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, reply, options);
      if (!actor) return;
      const administrators = await options.adminService.listPlatformAdmins();
      return reply.code(200).send({
        administrators: administrators.map((administrator) =>
          adminPlatformAdminSchema.parse(administrator),
        ),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.put("/api/admin/platform-admins/:userId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, reply, options);
      if (!actor) return;
      const params = userParamsSchema.parse(request.params);
      const input = adminPlatformAdminMutationRequestSchema.parse(request.body);
      await options.adminService.grantPlatformAdmin(
        actor.id,
        params.userId,
        input,
      );
      return reply.code(204).send();
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.delete("/api/admin/platform-admins/:userId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, reply, options);
      if (!actor) return;
      const params = userParamsSchema.parse(request.params);
      const input = adminPlatformAdminMutationRequestSchema.parse(request.body);
      await options.adminService.revokePlatformAdmin(
        actor.id,
        params.userId,
        input,
      );
      return reply.code(204).send();
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

  app.get("/api/admin/billing/plans", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const [plans, overview] = await Promise.all([
        options.adminService.listBillingPlans(),
        options.adminService.getBillingOverview(),
      ]);
      return reply.code(200).send({
        overview: adminBillingOverviewSchema.parse(overview),
        plans: plans.map((plan) => adminBillingPlanSchema.parse(plan)),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.patch(
    "/api/admin/billing/plans/:planCode/draft",
    async (request, reply) => {
      try {
        const user = await requirePlatformAdmin(request, reply, options);
        if (!user) return;
        const params = billingPlanParamsSchema.parse(request.params);
        const input = adminUpdateBillingPlanDraftSchema.parse(request.body);
        const plans = await options.adminService.updateBillingPlanDraft(
          user.id,
          params.planCode,
          input,
        );
        return reply.code(200).send({
          plans: plans.map((plan) => adminBillingPlanSchema.parse(plan)),
        });
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );

  app.post(
    "/api/admin/billing/plans/:planCode/draft",
    async (request, reply) => {
      try {
        const user = await requirePlatformAdmin(request, reply, options);
        if (!user) return;
        const params = billingPlanParamsSchema.parse(request.params);
        const input = adminBillingPlanMutationSchema.parse(request.body);
        const plans = await options.adminService.createBillingPlanDraft(
          user.id,
          params.planCode,
          input,
        );
        return reply.code(201).send({
          plans: plans.map((plan) => adminBillingPlanSchema.parse(plan)),
        });
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );

  app.post(
    "/api/admin/billing/plans/:planCode/publish",
    async (request, reply) => {
      try {
        const user = await requirePlatformAdmin(request, reply, options);
        if (!user) return;
        const params = billingPlanParamsSchema.parse(request.params);
        const input = adminBillingPlanMutationSchema.parse(request.body);
        const plans = await options.adminService.publishBillingPlan(
          user.id,
          params.planCode,
          input,
        );
        return reply.code(200).send({
          plans: plans.map((plan) => adminBillingPlanSchema.parse(plan)),
        });
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );

  app.get("/api/admin/billing/top-up-packs", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const packs = await options.adminService.listTopUpPacks();
      return reply.code(200).send({
        packs: packs.map((pack) => adminTopUpPackSchema.parse(pack)),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.put("/api/admin/billing/top-up-packs/draft", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const input = adminSaveTopUpPackDraftSchema.parse(request.body);
      const packs = await options.adminService.saveTopUpPackDraft(
        user.id,
        input,
      );
      return reply.code(200).send({
        packs: packs.map((pack) => adminTopUpPackSchema.parse(pack)),
      });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.post(
    "/api/admin/billing/top-up-packs/:code/publish",
    async (request, reply) => {
      try {
        const user = await requirePlatformAdmin(request, reply, options);
        if (!user) return;
        const params = topUpPackParamsSchema.parse(request.params);
        const input = adminBillingPlanMutationSchema.parse(request.body);
        const packs = await options.adminService.publishTopUpPack(
          user.id,
          params.code,
          input,
        );
        return reply.code(200).send({
          packs: packs.map((pack) => adminTopUpPackSchema.parse(pack)),
        });
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );

  app.get("/api/admin/payments/providers/dulupay", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const config = await options.adminService.getPaymentProviderConfig();
      return reply
        .code(200)
        .send({ config: adminPaymentProviderConfigSchema.parse(config) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.put("/api/admin/payments/providers/dulupay", async (request, reply) => {
    try {
      const user = await requirePlatformAdmin(request, reply, options);
      if (!user) return;
      const input = adminUpdatePaymentProviderConfigSchema.parse(request.body);
      const config = await options.adminService.updatePaymentProviderConfig(
        user.id,
        input,
      );
      return reply
        .code(200)
        .send({ config: adminPaymentProviderConfigSchema.parse(config) });
    } catch (error) {
      return sendAdminError(error, reply);
    }
  });

  app.post(
    "/api/admin/payments/providers/dulupay/test",
    async (request, reply) => {
      try {
        const user = await requirePlatformAdmin(request, reply, options);
        if (!user) return;
        const result = await options.adminService.testPaymentProvider();
        return reply.code(200).send(result);
      } catch (error) {
        return sendAdminError(error, reply);
      }
    },
  );
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
  if (error instanceof z.ZodError || isValidationError(error)) {
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

function isValidationError(
  error: unknown,
): error is { issues: Array<Record<string, unknown>> } {
  return (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
