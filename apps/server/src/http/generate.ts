// @credits-system — Direct generation routes with credit deduction and tier checks
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_VIDEO_RESOLUTION,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";

const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z
    .enum(["standard", "hd", "ultra"])
    .default(DEFAULT_IMAGE_QUALITY),
});

const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z
    .enum(["720p", "1080p", "4k"])
    .default(DEFAULT_VIDEO_RESOLUTION),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
});

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService?: JobService;
    tierGuard?: TierGuard;
    viewerService: ViewerService;
  },
) {
  app.post("/api/agent/generate-image", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateImageRequestSchema>;
    try {
      payload = generateImageRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    const model = payload.model ?? "google/nano-banana";

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message:
              "Image generation is not available (job service not configured).",
          },
        }),
      );
    }

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        await options.tierGuard.checkModelAccess(viewer.workspace.id, model);
        await options.tierGuard.checkResolution(
          viewer.workspace.id,
          payload.quality,
        );
        await options.tierGuard.checkImageModelQuality(model, payload.quality);
        creditsCost = options.tierGuard.calculateCreditCost(
          model,
          "image_generation",
          { quality: payload.quality },
        );
      }

      const job = await options.jobService.createJob(user, {
        workspaceId: viewer.workspace.id,
        jobType: "image_generation",
        ...(creditsCost > 0 ? { creditsCost } : {}),
        ...(creditsCost > 0
          ? { creditDescription: `Direct image generation: ${model}` }
          : {}),
        payload: {
          prompt: payload.prompt,
          model,
          aspect_ratio: payload.aspectRatio ?? "1:1",
          quality: payload.quality,
        },
      });

      const result = await pollJobUntilDone(
        options.jobService,
        job.id,
        2_000,
        180_000,
      );

      if ("error" in result) {
        return reply.code(502).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "generation_failed",
              message: result.error,
            },
          }),
        );
      }

      return reply.code(200).send({
        url: result.signed_url,
        assetId: result.asset_id,
        prompt: payload.prompt,
        mimeType: result.mime_type,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      // Handle tier/credit errors
      if (error instanceof TierGuardError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof CreditServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Image generation failed.";

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateVideoRequestSchema>;
    try {
      payload = generateVideoRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message:
              "Video generation is not available (job service not configured).",
          },
        }),
      );
    }

    const model = payload.model ?? "google-official/veo-3.1-generate-preview";

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        await options.tierGuard.checkModelAccess(workspaceId, model);
        await options.tierGuard.checkVideoResolution(
          workspaceId,
          payload.resolution,
        );
        await options.tierGuard.checkVideoModelResolution(
          model,
          payload.resolution,
        );
        creditsCost = options.tierGuard.calculateCreditCost(
          model,
          "video_generation",
          {
            ...(payload.duration != null ? { duration: payload.duration } : {}),
            resolution: payload.resolution,
          },
        );
      }

      // ── Create job ──
      const job = await options.jobService.createJob(user, {
        workspaceId,
        jobType: "video_generation",
        ...(creditsCost > 0 ? { creditsCost } : {}),
        ...(creditsCost > 0
          ? { creditDescription: `Direct video generation: ${model}` }
          : {}),
        payload: {
          prompt: payload.prompt,
          model,
          ...(payload.duration != null ? { duration: payload.duration } : {}),
          resolution: payload.resolution,
          ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
          ...(payload.inputImages?.length
            ? { input_images: payload.inputImages }
            : {}),
        },
      });

      // ── Poll until terminal state ──
      const POLL_INTERVAL = 3_000;
      const MAX_WAIT = 300_000; // 5 minutes

      const result = await pollJobUntilDone(
        options.jobService,
        job.id,
        POLL_INTERVAL,
        MAX_WAIT,
      );

      if ("error" in result) {
        return reply.code(502).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "generation_failed",
              message: result.error,
            },
          }),
        );
      }

      return reply.code(200).send({
        url: result.signed_url,
        assetId: result.asset_id,
        prompt: payload.prompt,
        mimeType: result.mime_type,
        width: result.width,
        height: result.height,
        durationSeconds: result.duration_seconds ?? 0,
      });
    } catch (error) {
      if (error instanceof TierGuardError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof CreditServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Video generation failed.";

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });
}

// ── Job polling helper ──────────────────────────────────────

type GenerationJobResult = {
  signed_url: string;
  asset_id: string;
  width: number;
  height: number;
  duration_seconds?: number;
  mime_type: string;
};

type PollResult = GenerationJobResult | { error: string };

async function pollJobUntilDone(
  jobService: JobService,
  jobId: string,
  pollInterval: number,
  maxWait: number,
): Promise<PollResult> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await delay(pollInterval);

    const current = await jobService.getJobAdmin(jobId);

    if (current.status === "succeeded" && current.result) {
      const r = current.result as Record<string, unknown>;
      return {
        signed_url: (r.signed_url as string) ?? "",
        asset_id: (r.asset_id as string) ?? "",
        width: (r.width as number) ?? 0,
        height: (r.height as number) ?? 0,
        ...(typeof r.duration_seconds === "number"
          ? { duration_seconds: r.duration_seconds }
          : {}),
        mime_type: (r.mime_type as string) ?? "application/octet-stream",
      };
    }

    if (current.status === "dead_letter" || current.status === "canceled") {
      return { error: current.error_message ?? `Job ${current.status}` };
    }

    if (
      current.status === "failed" &&
      current.attempt_count >= current.max_attempts
    ) {
      return {
        error: current.error_message ?? "Job failed after max retries",
      };
    }
  }

  return { error: `Job timed out after ${maxWait / 1000}s` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
