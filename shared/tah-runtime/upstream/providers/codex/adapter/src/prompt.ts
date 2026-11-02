import type { PromptPartV1 } from "../../../../src/contract/index.js";
import { projectNativePromptChannelsV1 } from "../../../../src/guest/adapter-kit/index.js";

export interface CodexPromptProjectionV1 {
  readonly developerInstructions: string;
  readonly turnInputText: string;
}

export function projectCodexPrompt(parts: readonly PromptPartV1[]): CodexPromptProjectionV1 {
  const common = projectNativePromptChannelsV1(parts);
  return Object.freeze({
    developerInstructions: common.instructions,
    turnInputText: common.referenceMessage,
  });
}
