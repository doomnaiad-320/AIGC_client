// @credits-system — Tier enforcement: model access and resolution limits per plan
import type {
  BackgroundJobType,
  BillingErrorCode,
  ImageQualityLevel,
  SubscriptionPlan,
  VideoResolution,
} from "@loomic/shared";
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_VIDEO_RESOLUTION,
  MODEL_MIN_TIER,
  getImageCreditCost,
  getVideoCreditCost,
  isImageQualityAtMost,
  isVideoResolutionAtMost,
} from "@loomic/shared";

import {
  getAvailableImageModel,
  getAvailableVideoModel,
} from "../../generation/providers/registry.js";
import type { BillingCatalogService } from "../billing/billing-catalog-service.js";
import {
  isImageQualityAllowed,
  isVideoResolutionAllowed,
} from "../billing/billing-catalog-service.js";

// ── Error ────────────────────────────────────────────────────

export type TierGuardErrorCode = Exclude<
  BillingErrorCode,
  "insufficient_credits"
>;

export class TierGuardError extends Error {
  readonly statusCode: number;
  readonly code: TierGuardErrorCode;

  constructor(
    code: TierGuardError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "TierGuardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type TierGuard = {
  checkModelAccess(workspaceId: string, modelId: string): Promise<void>;
  checkResolution(
    workspaceId: string,
    quality: ImageQualityLevel,
  ): Promise<void>;
  checkImageModelQuality(
    modelId: string,
    quality: ImageQualityLevel,
  ): Promise<void>;
  checkVideoResolution(
    workspaceId: string,
    resolution: VideoResolution,
  ): Promise<void>;
  checkVideoModelResolution(
    modelId: string,
    resolution: VideoResolution,
  ): Promise<void>;
  calculateCreditCost(
    modelId: string,
    jobType: BackgroundJobType,
    params?: {
      quality?: ImageQualityLevel;
      duration?: number;
      resolution?: VideoResolution;
    },
  ): number;
};

// ── Factory ──────────────────────────────────────────────────

export function createTierGuard(options: {
  billingCatalogService: BillingCatalogService;
}): TierGuard {
  return {
    async checkModelAccess(workspaceId, modelId) {
      const config =
        await options.billingCatalogService.getRuntimePlanConfig(workspaceId);
      const requiredGroup = getModelAccessGroup(modelId);
      if (!config.allowedModelGroups.includes(requiredGroup)) {
        throw new TierGuardError(
          "model_not_accessible",
          `当前${config.planName}不可使用模型“${modelId}”。`,
          403,
        );
      }
    },

    async checkResolution(workspaceId, quality) {
      const config =
        await options.billingCatalogService.getRuntimePlanConfig(workspaceId);
      if (!isImageQualityAllowed(config.maxImageQuality, quality)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `当前${config.planName}最高支持“${config.maxImageQuality}”图片质量。`,
          403,
        );
      }
    },

    async checkImageModelQuality(modelId, quality) {
      const model = getAvailableImageModel(modelId);
      if (!model) {
        throw new TierGuardError(
          "model_not_accessible",
          `图片模型“${modelId}”当前不可用。`,
          400,
        );
      }
      if (
        model.maxImageQuality &&
        !isImageQualityAtMost(quality, model.maxImageQuality)
      ) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `模型“${model.displayName}”最高支持“${model.maxImageQuality}”图片质量。`,
          400,
        );
      }
    },

    async checkVideoResolution(workspaceId, resolution) {
      const config =
        await options.billingCatalogService.getRuntimePlanConfig(workspaceId);
      if (!isVideoResolutionAllowed(config.maxVideoResolution, resolution)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `当前${config.planName}最高支持“${config.maxVideoResolution}”视频分辨率。`,
          403,
        );
      }
    },

    async checkVideoModelResolution(modelId, resolution) {
      const model = getAvailableVideoModel(modelId);
      if (!model) {
        throw new TierGuardError(
          "model_not_accessible",
          `视频模型“${modelId}”当前不可用。`,
          400,
        );
      }
      const maximum: VideoResolution =
        model.limits.maxResolution === "2160p"
          ? "4k"
          : model.limits.maxResolution === "480p"
            ? "720p"
            : model.limits.maxResolution;
      if (!isVideoResolutionAtMost(resolution, maximum)) {
        throw new TierGuardError(
          "resolution_not_allowed",
          `模型“${model.displayName}”最高支持“${maximum}”视频分辨率。`,
          400,
        );
      }
    },

    calculateCreditCost(modelId, jobType, params) {
      if (jobType === "image_generation") {
        const quality: ImageQualityLevel =
          params?.quality ?? DEFAULT_IMAGE_QUALITY;
        return getImageCreditCost(modelId, quality);
      }
      // video_generation
      return getVideoCreditCost(
        modelId,
        params?.duration,
        params?.resolution ?? DEFAULT_VIDEO_RESOLUTION,
      );
    },
  };
}

export function getModelAccessGroup(modelId: string) {
  const minimumPlan: SubscriptionPlan = MODEL_MIN_TIER[modelId] ?? "pro";
  if (minimumPlan === "free") return "free";
  if (minimumPlan === "starter") return "standard";
  if (minimumPlan === "pro") return "advanced";
  return "premium";
}
