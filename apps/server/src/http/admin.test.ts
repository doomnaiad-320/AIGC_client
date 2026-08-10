import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestAuthenticator } from "../auth/user.js";
import type { PlatformAdminService } from "../features/admin/platform-admin-service.js";
import { registerAdminRoutes } from "./admin.js";

const adminUser = {
  accessToken: "test-token",
  email: "operator@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};

function makeService(isAdmin: boolean): PlatformAdminService {
  return {
    isPlatformAdmin: vi.fn().mockResolvedValue(isAdmin),
    getOverview: vi.fn().mockResolvedValue({
      activeJobs: 1,
      adjustments24h: 0,
      failedJobs24h: 0,
      totalUsers: 2,
    }),
    listUsers: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
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
});
