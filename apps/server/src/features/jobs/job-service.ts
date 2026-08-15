import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
  Json,
} from "@loomic/shared";

import type { AuthenticatedUser, UserDbClient } from "../../auth/user.js";
import type { AdminDbClient } from "../../db/client.js";

export class JobServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "job_not_found"
    | "job_create_failed"
    | "insufficient_credits"
    | "job_forbidden"
    | "job_invalid_reference"
    | "concurrency_limit"
    | "job_query_failed"
    | "job_cancel_failed";

  constructor(
    code: JobServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CreateJobInput = {
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  creditsCost?: number;
  creditDescription?: string;
};

export type JobService = {
  createJob(
    user: AuthenticatedUser,
    input: CreateJobInput,
  ): Promise<BackgroundJob>;
  getJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  listJobs(
    user: AuthenticatedUser,
    filters?: { status?: BackgroundJobStatus; jobType?: BackgroundJobType },
  ): Promise<BackgroundJob[]>;
  cancelJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getJobAdmin(jobId: string): Promise<BackgroundJob>;

  // Admin-only methods (use admin client, no user auth)
  markRunning(jobId: string): Promise<boolean>;
  markSucceeded(jobId: string, result: Record<string, unknown>): Promise<void>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  incrementAttempt(
    jobId: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
};

export function createJobService(options: {
  createUserClient: (accessToken: string) => UserDbClient;
  getAdminClient: () => AdminDbClient;
}): JobService {
  async function mapJobRow(
    row: Record<string, unknown>,
    client: UserDbClient | AdminDbClient,
  ): Promise<BackgroundJob> {
    const rawResult = (row.result as Record<string, unknown>) ?? null;
    let result = rawResult;
    const objectPath = rawResult?.object_path;
    if (typeof objectPath === "string" && objectPath.length > 0) {
      const bucket =
        typeof rawResult.bucket === "string"
          ? rawResult.bucket
          : "project-assets";
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(objectPath, 3600);
      if (error || !data?.signedUrl) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to create a private asset URL for this job.",
          500,
        );
      }
      result = { ...rawResult, signed_url: data.signedUrl };
    }

    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      project_id: (row.project_id as string) ?? null,
      canvas_id: (row.canvas_id as string) ?? null,
      session_id: (row.session_id as string) ?? null,
      thread_id: (row.thread_id as string) ?? null,
      queue_name: row.queue_name as string,
      job_type: row.job_type as BackgroundJob["job_type"],
      status: row.status as BackgroundJob["status"],
      payload: (row.payload as Record<string, unknown>) ?? {},
      result,
      error_code: (row.error_code as string) ?? null,
      error_message: (row.error_message as string) ?? null,
      attempt_count: row.attempt_count as number,
      max_attempts: row.max_attempts as number,
      created_by: row.created_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string) ?? null,
      completed_at: (row.completed_at as string) ?? null,
      failed_at: (row.failed_at as string) ?? null,
      canceled_at: (row.canceled_at as string) ?? null,
    };
  }

  const SELECT_COLS =
    "id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

  return {
    async createJob(user, input) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client.rpc<Record<string, unknown>>(
        "create_and_enqueue_generation_job",
        {
          p_workspace_id: input.workspaceId,
          p_project_id: input.projectId ?? null,
          p_canvas_id: input.canvasId ?? null,
          p_session_id: input.sessionId ?? null,
          p_thread_id: input.threadId ?? null,
          p_job_type: input.jobType,
          p_payload: input.payload,
          p_user_id: user.id,
          p_credits_cost: input.creditsCost ?? 0,
          p_credit_description: input.creditDescription ?? null,
        },
      );

      if (error || !job) {
        if (error?.message.includes("GENERATION_CONCURRENCY_LIMIT")) {
          throw new JobServiceError(
            "concurrency_limit",
            "Concurrent generation limit reached. Wait for a job to finish or upgrade your plan.",
            429,
          );
        }
        if (error?.message.includes("INSUFFICIENT_CREDITS")) {
          throw new JobServiceError(
            "insufficient_credits",
            "Not enough credits to perform this action.",
            402,
          );
        }
        if (error?.message.includes("GENERATION_WORKSPACE_ACCESS_DENIED")) {
          throw new JobServiceError(
            "job_forbidden",
            "You do not have access to this workspace.",
            403,
          );
        }
        if (
          error?.message.includes("GENERATION_PROJECT_WORKSPACE_MISMATCH") ||
          error?.message.includes("GENERATION_CANVAS_WORKSPACE_MISMATCH") ||
          error?.message.includes("GENERATION_SESSION_WORKSPACE_MISMATCH") ||
          error?.message.includes("GENERATION_JOB_TYPE_INVALID") ||
          error?.message.includes("GENERATION_PAYLOAD_INVALID")
        ) {
          throw new JobServiceError(
            "job_invalid_reference",
            "The job references resources outside the selected workspace.",
            400,
          );
        }
        throw new JobServiceError(
          "job_create_failed",
          "Failed to create and enqueue job.",
          500,
        );
      }

      return await mapJobRow(job as unknown as Record<string, unknown>, client);
    },

    async getJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return await mapJobRow(job as unknown as Record<string, unknown>, client);
    },

    async listJobs(user, filters) {
      const client = options.createUserClient(user.accessToken);
      let query = client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (filters?.status) query = query.eq("status", filters.status);
      if (filters?.jobType) query = query.eq("job_type", filters.jobType);

      const { data: jobs, error } = await query;
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to list jobs.",
          500,
        );
      }
      return await Promise.all(
        ((jobs ?? []) as any[]).map((row: any) =>
          mapJobRow(row as unknown as Record<string, unknown>, client),
        ),
      );
    },

    async cancelJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["queued", "running"])
        .select(SELECT_COLS)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_cancel_failed",
          "Failed to cancel job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError(
          "job_not_found",
          "Job not found or already completed.",
          404,
        );
      }
      return await mapJobRow(job as unknown as Record<string, unknown>, client);
    },

    async getJobAdmin(jobId) {
      const admin = options.getAdminClient();
      const { data: job, error } = await admin
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return await mapJobRow(job as unknown as Record<string, unknown>, admin);
    },

    // --- Admin-only methods (admin client, bypasses RLS) ---

    async markRunning(jobId) {
      const admin = options.getAdminClient();
      const { data, error } = await admin
        .from("background_jobs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to claim job.",
          500,
        );
      }
      return Boolean(data);
    },

    async markSucceeded(jobId, result) {
      const admin = options.getAdminClient();
      await admin
        .from("background_jobs")
        .update({
          status: "succeeded",
          result: result as Json,
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    },

    async markFailed(jobId, errorCode, errorMessage) {
      const admin = options.getAdminClient();
      await admin
        .from("background_jobs")
        .update({
          status: "failed",
          error_code: errorCode,
          error_message: errorMessage,
          failed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    },

    async markDeadLetter(jobId, errorCode, errorMessage) {
      const admin = options.getAdminClient();
      await admin
        .from("background_jobs")
        .update({
          status: "dead_letter",
          error_code: errorCode,
          error_message: errorMessage,
          failed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    },

    async incrementAttempt(jobId) {
      const admin = options.getAdminClient();
      // NOTE: increment_job_attempt may not be in generated PostgreSQL types yet.
      const { data, error } = await (admin as any).rpc(
        "increment_job_attempt",
        {
          p_job_id: jobId,
        },
      );

      if (error) {
        console.error(
          "[job-service] increment_job_attempt RPC failed:",
          error.message,
        );
        return { attempt_count: 1, max_attempts: 3 };
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (row && typeof row === "object") {
        return {
          attempt_count: (row as any).attempt_count as number,
          max_attempts: ((row as any).max_attempts as number) ?? 3,
        };
      }
      // Job not found — return safe defaults
      return { attempt_count: 1, max_attempts: 3 };
    },
  };
}
