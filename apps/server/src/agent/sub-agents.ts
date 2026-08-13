import type { SubAgent } from "deepagents";

import {
  createVideoGenerateTool,
  type SubmitVideoJobFn,
} from "./tools/video-generate.js";

export function createVideoSubAgent(deps?: {
  submitVideoJob?: SubmitVideoJobFn;
}): SubAgent {
  return {
    name: "video_generate",
    description:
      "Generate a video based on a creative description. Video generation availability depends on provider configuration.",
    systemPrompt: `You are a video generation specialist. Given a description, generate a video using the generate_video tool and return the result.

If video generation is not available or fails, clearly explain the limitation.`,
    tools: [
      createVideoGenerateTool(
        deps?.submitVideoJob ? { submitVideoJob: deps.submitVideoJob } : undefined,
      ),
    ],
  };
}
