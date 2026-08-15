import {
  DEFAULT_VIDEO_RESOLUTION,
  type VideoResolution,
  isVideoResolutionAtMost,
} from "@loomic/shared";
import type { GeneratedVideo, VideoGenerateParams } from "./types.js";

import {
  getAvailableVideoModel,
  getVideoProvider,
} from "./providers/registry.js";
import { GenerationError } from "./utils.js";

export async function generateVideo(
  providerName: string,
  params: VideoGenerateParams,
): Promise<GeneratedVideo> {
  const provider = getVideoProvider(providerName);
  const model = getAvailableVideoModel(params.model);
  if (!model) {
    throw new GenerationError(
      providerName,
      "model_not_found",
      `No registered video model: ${params.model}`,
    );
  }
  const resolution = params.resolution ?? DEFAULT_VIDEO_RESOLUTION;
  const maximum: VideoResolution =
    model.limits.maxResolution === "2160p"
      ? "4k"
      : model.limits.maxResolution === "480p"
        ? "720p"
        : model.limits.maxResolution;
  if (!isVideoResolutionAtMost(resolution, maximum)) {
    throw new GenerationError(
      providerName,
      "invalid_input",
      `Model ${params.model} supports video resolution up to ${maximum}, requested ${resolution}.`,
    );
  }
  return provider.generate({ ...params, resolution });
}
