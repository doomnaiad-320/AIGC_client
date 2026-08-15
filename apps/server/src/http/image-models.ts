// @credits-system — Image model list with tier annotations, credit costs, and accessibility flags
import type { FastifyInstance } from "fastify";

import {
  type ImageQualityLevel,
  MODEL_MIN_TIER,
  getImageCreditCost,
} from "@loomic/shared";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { getModelAccessGroup } from "../features/credits/tier-guard.js";
import { getAvailableImageModels } from "../generation/providers/registry.js";

export async function registerImageModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/image-models", async (request, reply) => {
    const models = getAvailableImageModels();

    // Try to authenticate — unauthenticated users still see models
    let allowedModelGroups: string[] | null = null;
    let maxAllowedQuality: ImageQualityLevel | null = null;
    try {
      const user = await options.auth.authenticate(request);
      if (user) {
        const viewer = await options.viewerService.ensureViewer(user);
        const config = await options.creditService.getPlanConfig(
          viewer.workspace.id,
        );
        allowedModelGroups = config.allowedModelGroups;
        maxAllowedQuality = config.maxImageQuality;
      }
    } catch {
      // Auth failure is non-fatal — just show models as inaccessible
    }

    const annotated = models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      iconUrl: m.iconUrl,
      provider: m.provider,
      accessible:
        allowedModelGroups?.includes(getModelAccessGroup(m.id)) ?? false,
      creditCost: getImageCreditCost(m.id, "standard"),
      creditCosts: {
        standard: getImageCreditCost(m.id, "standard"),
        hd: getImageCreditCost(m.id, "hd"),
        ultra: getImageCreditCost(m.id, "ultra"),
      },
      maxImageQuality: m.maxImageQuality ?? "ultra",
      maxAllowedQuality,
      minTier: MODEL_MIN_TIER[m.id] ?? "pro",
    }));

    return reply.code(200).send({ models: annotated });
  });
}
