import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../../auth/user.js";
import { JobServiceError, createJobService } from "./job-service.js";

const user: AuthenticatedUser = {
  accessToken:
    "header.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEifQ.signature",
  authVersion: 0,
  email: "test@example.com",
  id: "11111111-1111-4111-8111-111111111111",
  userMetadata: {},
};

describe("JobService atomic admission", () => {
  it("maps a database concurrency rejection to HTTP 429", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "GENERATION_CONCURRENCY_LIMIT",
      },
    });
    const service = createJobService({
      createUserClient: vi.fn(() => ({ rpc }) as any),
      getAdminClient: vi.fn() as any,
    });

    await expect(
      service.createJob(user, {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        jobType: "image_generation",
        payload: { prompt: "test" },
      }),
    ).rejects.toMatchObject({
      code: "concurrency_limit",
      statusCode: 429,
    });
    expect(rpc).toHaveBeenCalledWith("create_and_enqueue_generation_job", {
      p_workspace_id: "22222222-2222-4222-8222-222222222222",
      p_project_id: null,
      p_canvas_id: null,
      p_session_id: null,
      p_thread_id: null,
      p_job_type: "image_generation",
      p_payload: { prompt: "test" },
      p_user_id: user.id,
      p_credits_cost: 0,
      p_credit_description: null,
    });
  });

  it.each([
    { claimed: true, row: { id: "33333333-3333-4333-8333-333333333333" } },
    { claimed: false, row: null },
  ])(
    "returns $claimed when the queued job claim resolves",
    async ({ claimed, row }) => {
      const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
      const query = {
        eq: vi.fn(),
        maybeSingle,
        select: vi.fn(),
        update: vi.fn(),
      };
      query.update.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      query.select.mockReturnValue(query);
      const service = createJobService({
        createUserClient: vi.fn() as any,
        getAdminClient: vi.fn(() => ({
          from: vi.fn(() => query),
        })) as any,
      });

      await expect(
        service.markRunning("33333333-3333-4333-8333-333333333333"),
      ).resolves.toBe(claimed);
      expect(query.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "running" }),
      );
      expect(query.eq).toHaveBeenCalledWith("status", "queued");
    },
  );

  it("refreshes a private result URL when a completed job is read", async () => {
    const row = {
      attempt_count: 1,
      canceled_at: null,
      canvas_id: null,
      completed_at: "2026-08-14T00:00:00.000Z",
      created_at: "2026-08-14T00:00:00.000Z",
      created_by: user.id,
      error_code: null,
      error_message: null,
      failed_at: null,
      id: "33333333-3333-4333-8333-333333333333",
      job_type: "image_generation",
      max_attempts: 3,
      payload: { prompt: "test" },
      project_id: null,
      queue_name: "image_generation_jobs",
      result: {
        asset_id: "44444444-4444-4444-8444-444444444444",
        bucket: "project-assets",
        object_path: "workspace/generated/image.png",
      },
      session_id: null,
      started_at: "2026-08-14T00:00:00.000Z",
      status: "succeeded",
      thread_id: null,
      updated_at: "2026-08-14T00:00:00.000Z",
      workspace_id: "22222222-2222-4222-8222-222222222222",
    };
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const query = { eq: vi.fn(), maybeSingle, select: vi.fn() };
    query.eq.mockReturnValue(query);
    query.select.mockReturnValue(query);
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "http://localhost/private?token=signed" },
      error: null,
    });
    const service = createJobService({
      createUserClient: vi.fn(
        () =>
          ({
            from: vi.fn(() => query),
            storage: {
              from: vi.fn(() => ({ createSignedUrl })),
            },
          }) as any,
      ),
      getAdminClient: vi.fn() as any,
    });

    const job = await service.getJob(user, row.id);

    expect(job.result?.signed_url).toBe(
      "http://localhost/private?token=signed",
    );
    expect(createSignedUrl).toHaveBeenCalledWith(
      "workspace/generated/image.png",
      3600,
    );
  });
});
