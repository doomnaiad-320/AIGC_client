import { describe, expect, it, vi } from "vitest";

import { createAdminDbClient, createUserDbClientFactory } from "./client.js";
import type { PostgresPool } from "./postgres.js";

describe("billing plan RPC mappings", () => {
  it.each([
    {
      args: {
        p_actor_user_id: "11111111-1111-4111-8111-111111111111",
        p_plan_code: "pro",
        p_reason: "创建专业版草稿",
      },
      functionName: "admin_create_billing_plan_draft",
      sql: "select public.admin_create_billing_plan_draft($1::uuid, $2::text, $3::text) as result",
      values: ["11111111-1111-4111-8111-111111111111", "pro", "创建专业版草稿"],
    },
    {
      args: {
        p_actor_user_id: "11111111-1111-4111-8111-111111111111",
        p_annual_price_minor: 34800,
        p_currency: "USD",
        p_daily_credits: 50,
        p_entitlements: { "generation.max_concurrent_jobs": 4 },
        p_monthly_price_minor: 3900,
        p_monthly_subscription_credits: 5000,
        p_plan_code: "pro",
        p_reason: "调整专业版权益",
        p_top_up_eligible: true,
      },
      functionName: "admin_save_billing_plan_draft",
      sql: "select public.admin_save_billing_plan_draft($1::uuid, $2::text, $3::text, $4::int, $5::int, $6::int, $7::int, $8::boolean, $9::jsonb, $10::text) as result",
      values: [
        "11111111-1111-4111-8111-111111111111",
        "pro",
        "USD",
        3900,
        34800,
        5000,
        50,
        true,
        JSON.stringify({ "generation.max_concurrent_jobs": 4 }),
        "调整专业版权益",
      ],
    },
    {
      args: {
        p_actor_user_id: "11111111-1111-4111-8111-111111111111",
        p_plan_code: "pro",
        p_reason: "发布专业版权益",
      },
      functionName: "admin_publish_billing_plan",
      sql: "select public.admin_publish_billing_plan($1::uuid, $2::text, $3::text) as result",
      values: ["11111111-1111-4111-8111-111111111111", "pro", "发布专业版权益"],
    },
  ])("maps $functionName to PostgreSQL", async (testCase) => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.startsWith("select set_config")) return { rows: [] };
      return { rows: [{ result: "22222222-2222-4222-8222-222222222222" }] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as PostgresPool;
    const client = createAdminDbClient(
      {
        appJwtSecret: "test-secret",
        databaseUrl: "postgresql:///test",
        postgresPoolMax: 1,
        serverPublicUrl: "http://localhost:3001",
        storageRoot: ".test-storage",
      },
      pool,
    );

    const result = await client.rpc(testCase.functionName, testCase.args);

    expect(result).toEqual({
      data: "22222222-2222-4222-8222-222222222222",
      error: null,
    });
    expect(query).toHaveBeenCalledWith(testCase.sql, testCase.values);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("runtime database roles", () => {
  it("switches admin queries to service_role before setting request context", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as PostgresPool;
    const client = createAdminDbClient(
      {
        appJwtSecret: "test-secret",
        databaseUrl: "postgresql:///test",
        postgresPoolMax: 1,
        serverPublicUrl: "http://localhost:3001",
        storageRoot: ".test-storage",
      },
      pool,
    );

    await client.query("select 1");

    expect(query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      "begin",
      "set local role service_role",
      "select set_config($1, $2, true)",
      "select set_config($1, $2, true)",
      "select 1",
      "commit",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("switches user queries to authenticated before setting the user id", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [],
    }));
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as PostgresPool;
    const createUserClient = createUserDbClientFactory(
      {
        appJwtSecret: "test-secret",
        databaseUrl: "postgresql:///test",
        postgresPoolMax: 1,
        serverPublicUrl: "http://localhost:3001",
        storageRoot: ".test-storage",
      },
      pool,
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: "11111111-1111-4111-8111-111111111111" }),
    ).toString("base64url");

    await createUserClient(`header.${payload}.signature`)
      .from("projects")
      .select("id");

    expect(query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      "begin",
      "set local role authenticated",
      "select set_config($1, $2, true)",
      "select set_config($1, $2, true)",
      'select t."id" from "projects" as t',
      "commit",
    ]);
    expect(query).toHaveBeenNthCalledWith(
      4,
      "select set_config($1, $2, true)",
      ["app.user_id", "11111111-1111-4111-8111-111111111111"],
    );
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("generation admission RPC mapping", () => {
  it("maps atomic job creation and queue admission to PostgreSQL", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.startsWith("select set_config")) return { rows: [] };
      return {
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            status: "queued",
          },
        ],
      };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as PostgresPool;
    const client = createAdminDbClient(
      {
        appJwtSecret: "test-secret",
        databaseUrl: "postgresql:///test",
        postgresPoolMax: 1,
        serverPublicUrl: "http://localhost:3001",
        storageRoot: ".test-storage",
      },
      pool,
    );

    const payload = { prompt: "atomic mapping", model: "test-model" };
    const result = await client.rpc("create_and_enqueue_generation_job", {
      p_workspace_id: "11111111-1111-4111-8111-111111111111",
      p_project_id: null,
      p_canvas_id: null,
      p_session_id: null,
      p_thread_id: null,
      p_job_type: "image_generation",
      p_payload: payload,
    });

    expect(result).toEqual({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        status: "queued",
      },
      error: null,
    });
    expect(query).toHaveBeenCalledWith(
      "select * from public.create_and_enqueue_generation_job($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::public.background_job_type, $7::jsonb)",
      [
        "11111111-1111-4111-8111-111111111111",
        null,
        null,
        null,
        null,
        "image_generation",
        JSON.stringify(payload),
      ],
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
