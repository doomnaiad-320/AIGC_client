import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAuthenticator } from "../auth/user.js";
import type { PlatformAdminService } from "../features/admin/platform-admin-service.js";
import { registerAdminRoutes } from "./admin.js";

const adminUser = {
  accessToken: "test-token",
  authVersion: 0,
  email: "operator@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};

function makeService(isAdmin: boolean): PlatformAdminService {
  const userDetail = {
    recentAgentRuns: [],
    recentJobs: [],
    recentTransactions: [],
    workspaces: [],
    user: {
      balance: 100,
      createdAt: "2026-08-10T00:00:00.000Z",
      displayName: "Operator",
      email: "operator@example.com",
      id: "11111111-1111-4111-8111-111111111111",
      isPlatformAdmin: true,
      lastSignInAt: null,
      plan: "pro" as const,
      status: "active" as const,
      statusChangedAt: null,
      statusReason: null,
      workspaceId: "33333333-3333-4333-8333-333333333333",
      workspaceName: "Operator Workspace",
    },
  };
  return {
    isPlatformAdmin: vi.fn().mockResolvedValue(isAdmin),
    getOverview: vi.fn().mockResolvedValue({
      activeJobs: 1,
      adjustments24h: 0,
      failedJobs24h: 0,
      totalUsers: 2,
    }),
    listUsers: vi.fn().mockResolvedValue([]),
    getUserDetail: vi.fn().mockResolvedValue(userDetail),
    listUserWorkspaces: vi.fn().mockResolvedValue([]),
    updateUser: vi.fn().mockResolvedValue(userDetail),
    updateUserStatus: vi.fn().mockResolvedValue(userDetail),
    createPasswordReset: vi.fn().mockResolvedValue({
      expiresAt: "2026-08-10T00:30:00.000Z",
      resetToken: "a".repeat(43),
    }),
    listPlatformAdmins: vi.fn().mockResolvedValue([]),
    grantPlatformAdmin: vi.fn().mockResolvedValue(undefined),
    revokePlatformAdmin: vi.fn().mockResolvedValue(undefined),
    listJobs: vi.fn().mockResolvedValue([]),
    listAgentRuns: vi.fn().mockResolvedValue([]),
    listTransactions: vi.fn().mockResolvedValue([]),
    listAuditEvents: vi.fn().mockResolvedValue([]),
    adjustCredits: vi.fn().mockResolvedValue({
      balance: 100,
      transactionId: "22222222-2222-4222-8222-222222222222",
    }),
  };
}

async function makeApp(
  auth: RequestAuthenticator,
  adminService: PlatformAdminService,
) {
  const app = Fastify();
  await registerAdminRoutes(app, { adminService, auth });
  return app;
}

describe("admin routes", () => {
  it("rejects requests without a session", async () => {
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(null) },
      makeService(false),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 instead of loading platform data for a non-admin", async () => {
    const service = makeService(false);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
    });
    expect(response.statusCode).toBe(403);
    expect(service.getOverview).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns overview data to a platform admin", async () => {
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      makeService(true),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      overview: {
        activeJobs: 1,
        adjustments24h: 0,
        failedJobs24h: 0,
        totalUsers: 2,
      },
    });
    await app.close();
  });

  it("returns user detail to a platform admin", async () => {
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      makeService(true),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users/11111111-1111-4111-8111-111111111111",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().detail.user.email).toBe("operator@example.com");
    await app.close();
  });

  it("updates user status with the authenticated administrator as actor", async () => {
    const service = makeService(true);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/22222222-2222-4222-8222-222222222222/status",
      payload: {
        reason: "Repeated policy violations",
        status: "suspended",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(service.updateUserStatus).toHaveBeenCalledWith(
      adminUser.id,
      "22222222-2222-4222-8222-222222222222",
      {
        reason: "Repeated policy violations",
        status: "suspended",
      },
    );
    await app.close();
  });

  it("requires a reason before issuing a password reset", async () => {
    const service = makeService(true);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/22222222-2222-4222-8222-222222222222/password-reset",
      payload: { reason: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createPasswordReset).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a one-time password reset token to a platform admin", async () => {
    const service = makeService(true);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/22222222-2222-4222-8222-222222222222/password-reset",
      payload: { reason: "Account owner requested access recovery" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().resetToken).toHaveLength(43);
    expect(service.createPasswordReset).toHaveBeenCalledWith(
      adminUser.id,
      "22222222-2222-4222-8222-222222222222",
      { reason: "Account owner requested access recovery" },
    );
    await app.close();
  });

  it("prevents a non-admin from granting platform access", async () => {
    const service = makeService(false);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-admins/22222222-2222-4222-8222-222222222222",
      payload: { reason: "Operations coverage" },
    });
    expect(response.statusCode).toBe(403);
    expect(service.grantPlatformAdmin).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns agent runs to a platform admin", async () => {
    const service = makeService(true);
    service.listAgentRuns = vi.fn().mockResolvedValue([
      {
        canvasName: "Main Canvas",
        completedAt: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        errorCode: null,
        errorMessage: null,
        id: "44444444-4444-4444-8444-444444444444",
        model: "gpt-4.1",
        projectName: "Demo",
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionTitle: "Demo Chat",
        status: "running",
        threadId: "thread_demo",
        userDisplayName: "Operator",
        userEmail: "operator@example.com",
        workspaceName: "Operator Workspace",
      },
    ]);
    const app = await makeApp(
      { authenticate: vi.fn().mockResolvedValue(adminUser) },
      service,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runs).toHaveLength(1);
    await app.close();
  });
});
