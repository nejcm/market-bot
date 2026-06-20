import type { AppConfig } from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createCodexProvider } from "./codex";
import { createOpenAIProvider } from "./openai";
import type { ModelProvider } from "./types";

export function createProvider(config: AppConfig): ModelProvider {
  if (config.provider === "codex") {
    return createCodexProvider(config);
  }

  if (config.provider === "anthropic") {
    return createAnthropicProvider(config);
  }

  return createOpenAIProvider(config);
}
