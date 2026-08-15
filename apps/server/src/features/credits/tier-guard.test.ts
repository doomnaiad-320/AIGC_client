import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingCatalogService } from "../billing/billing-catalog-service.js";
import {
  clearProviders,
  registerImageProvider,
  registerVideoProvider,
} from "../../generation/providers/registry.js";
import { createTierGuard } from "./tier-guard.js";

const getRuntimePlanConfig = vi.fn(async () => ({
  allowedModelGroups: ["free", "standard", "advanced"],
  annualPriceMinor: 0,
  apiEnabled: false,
  currency: "USD",
  dailyCredits: 0,
  legacyPlan: "pro" as const,
  maxBrandKits: 10,
  maxConcurrentJobs: 4,
  maxImageQuality: "hd" as const,
  maxProjects: 50,
  maxTeamSeats: 1,
  maxVideoResolution: "1080p" as const,
  monthlyPriceMinor: 0,
  monthlySubscriptionCredits: 5000,
  planCode: "pro" as const,
  planName: "Pro",
  planVersionId: "plan-version",
  queuePriority: "standard" as const,
  topUpEligible: true,
  watermark: false,
}));

const billingCatalogService = {
  getRuntimePlanConfig,
} as unknown as BillingCatalogService;

describe("TierGuard generation quality enforcement", () => {
  beforeEach(() => {
    clearProviders();
    registerImageProvider({
      name: "test-image",
      models: [
        {
          id: "google/nano-banana",
          displayName: "Nano Banana",
          description: "test",
          maxImageQuality: "standard",
        },
        {
          id: "black-forest-labs/flux-kontext-pro",
          displayName: "Flux Kontext Pro",
          description: "test",
          maxImageQuality: "hd",
        },
      ],
      generate: vi.fn(),
    });
    registerVideoProvider({
      name: "test-video",
      models: [
        {
          id: "google-official/veo-3.1-generate-preview",
          displayName: "Veo 3.1",
          description: "test",
          capabilities: {
            audio: true,
            imageToVideo: true,
            textToVideo: true,
            videoToVideo: false,
          },
          limits: {
            maxDuration: 8,
            maxInputImages: 1,
            maxResolution: "2160p",
          },
        },
        {
          id: "google-official/veo-2.0-generate-001",
          displayName: "Veo 2",
          description: "test",
          capabilities: {
            audio: false,
            imageToVideo: true,
            textToVideo: true,
            videoToVideo: false,
          },
          limits: {
            maxDuration: 8,
            maxInputImages: 1,
            maxResolution: "720p",
          },
        },
      ],
      generate: vi.fn(),
    });
  });

  it("allows the standard image default and charges its exact price", async () => {
    const guard = createTierGuard({ billingCatalogService });

    await expect(
      guard.checkResolution("workspace", "standard"),
    ).resolves.toBeUndefined();
    await expect(
      guard.checkImageModelQuality("google/nano-banana", "standard"),
    ).resolves.toBeUndefined();
    expect(
      guard.calculateCreditCost(
        "black-forest-labs/flux-kontext-pro",
        "image_generation",
        { quality: "standard" },
      ),
    ).toBe(8);
  });

  it("rejects unsupported image and video quality before job creation", async () => {
    const guard = createTierGuard({ billingCatalogService });

    await expect(
      guard.checkImageModelQuality("google/nano-banana", "hd"),
    ).rejects.toMatchObject({ code: "resolution_not_allowed" });
    await expect(
      guard.checkVideoModelResolution(
        "google-official/veo-2.0-generate-001",
        "1080p",
      ),
    ).rejects.toMatchObject({ code: "resolution_not_allowed" });
  });

  it("uses resolution multipliers consistently for video", () => {
    const guard = createTierGuard({ billingCatalogService });

    expect(
      guard.calculateCreditCost(
        "google-official/veo-3.1-generate-preview",
        "video_generation",
        { duration: 8, resolution: "720p" },
      ),
    ).toBe(125);
    expect(
      guard.calculateCreditCost(
        "google-official/veo-3.1-generate-preview",
        "video_generation",
        { duration: 8, resolution: "1080p" },
      ),
    ).toBe(250);
    expect(
      guard.calculateCreditCost(
        "google-official/veo-3.1-generate-preview",
        "video_generation",
        { duration: 8, resolution: "4k" },
      ),
    ).toBe(500);
  });
});
