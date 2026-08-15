import type { GeneratedImage, ImageGenerateParams } from "./types.js";
import { DEFAULT_IMAGE_QUALITY, isImageQualityAtMost } from "@loomic/shared";

import {
  getAvailableImageModel,
  getImageProvider,
} from "./providers/registry.js";
import { GenerationError } from "./utils.js";

export async function generateImage(
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = getImageProvider(providerName);
  const model = getAvailableImageModel(params.model);
  if (!model) {
    throw new GenerationError(
      providerName,
      "model_not_found",
      `No registered image model: ${params.model}`,
    );
  }
  const quality = params.quality ?? DEFAULT_IMAGE_QUALITY;
  if (
    model.maxImageQuality &&
    !isImageQualityAtMost(quality, model.maxImageQuality)
  ) {
    throw new GenerationError(
      providerName,
      "invalid_input",
      `Model ${params.model} supports image quality up to ${model.maxImageQuality}, requested ${quality}.`,
    );
  }
  return provider.generate({ ...params, quality });
}
