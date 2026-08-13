import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../../auth/user.js";
import { JobServiceError, createJobService } from "./job-service.js";

const user: AuthenticatedUser = {
  accessToken: "header.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEifQ.signature",
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
    });
  });
});
