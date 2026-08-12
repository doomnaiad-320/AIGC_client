// @credits-system — Video model list with tier annotations, credit costs, and accessibility flags
import type { FastifyInstance } from "fastify";

import { MODEL_MIN_TIER, getVideoCreditCost } from "@loomic/shared";

import type { RequestAuthenticator } from "../auth/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { getModelAccessGroup } from "../features/credits/tier-guard.js";
import { getAvailableVideoModels } from "../generation/providers/registry.js";

export async function registerVideoModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/video-models", async (request, reply) => {
    const models = getAvailableVideoModels();

    // Try to authenticate — unauthenticated users still see models
    let allowedModelGroups: string[] | null = null;
    try {
      const user = await options.auth.authenticate(request);
      if (user) {
        const viewer = await options.viewerService.ensureViewer(user);
        const config = await options.creditService.getPlanConfig(
          viewer.workspace.id,
        );
        allowedModelGroups = config.allowedModelGroups;
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
      creditCost: getVideoCreditCost(m.id),
      minTier: MODEL_MIN_TIER[m.id] ?? "pro",
    }));

    return reply.code(200).send({ models: annotated });
  });
}
