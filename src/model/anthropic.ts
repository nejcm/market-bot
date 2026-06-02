import type { AppConfig } from "../config";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "./types";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16_384;
const JSON_INSTRUCTION =
  "IMPORTANT: Respond with a valid JSON object only. No prose, no markdown, no code fences.";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface AnthropicResponse {
  readonly content?: readonly AnthropicContentBlock[];
  readonly usage?: AnthropicUsage;
}

function readAnthropicResponse(value: unknown): AnthropicResponse {
  return typeof value === "object" && value !== null ? (value as AnthropicResponse) : {};
}

function buildSystem(
  messages: readonly ModelMessage[],
  responseFormat: "json" | undefined,
): string | undefined {
  const systemContent = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  if (responseFormat !== "json") {
    return systemContent.trim() !== "" ? systemContent : undefined;
  }

  return systemContent.trim() !== "" ? `${systemContent}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length / 4, 0);
}

export function createAnthropicProvider(
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): ModelProvider {
  if (config.apiKey === undefined) {
    throw new Error("ANTHROPIC_API_KEY or MARKET_BOT_ANTHROPIC_API_KEY is required");
  }
  const { apiKey } = config;

  return {
    name: "anthropic",
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const system = buildSystem(request.messages, request.responseFormat);
      const messages = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));

      const response = await fetchImpl(`${ANTHROPIC_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.params?.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages,
          ...(request.params?.reasoningEffort !== undefined
            ? { output_config: { effort: request.params.reasoningEffort } }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic request failed with status ${String(response.status)}`);
      }

      const payload = readAnthropicResponse(await response.json());
      const content =
        payload.content
          ?.filter((block) => block.type === "text" && block.text !== undefined)
          .map((block) => block.text)
          .join("") ?? "";

      if (content.trim() === "") {
        throw new Error("Anthropic response did not include content");
      }

      const tokenEstimate =
        payload.usage?.input_tokens !== undefined || payload.usage?.output_tokens !== undefined
          ? (payload.usage.input_tokens ?? 0) + (payload.usage.output_tokens ?? 0)
          : estimateTokens(request.messages);

      return {
        content,
        tokenEstimate,
        costEstimateUsd: 0,
      };
    },
  };
}
