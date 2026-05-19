import type { AppConfig } from "../config";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";

interface OpenAIChoice {
  readonly message?: {
    readonly content?: string;
  };
}

interface OpenAIUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface OpenAIResponse {
  readonly choices?: readonly OpenAIChoice[];
  readonly usage?: OpenAIUsage;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function readOpenAIResponse(value: unknown): OpenAIResponse {
  return typeof value === "object" && value !== null ? (value as OpenAIResponse) : {};
}

export function createOpenAIProvider(config: AppConfig, fetchImpl: FetchLike = fetch): ModelProvider {
  if (config.apiKey === undefined) {
    throw new Error("OPENAI_API_KEY or MARKET_BOT_OPENAI_API_KEY is required");
  }

  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    name: config.provider,
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with status ${response.status}`);
      }

      const payload = readOpenAIResponse(await response.json());
      const content = payload.choices?.[0]?.message?.content;

      if (content === undefined || content.trim() === "") {
        throw new Error("OpenAI response did not include content");
      }

      const tokenEstimate = payload.usage?.total_tokens ?? request.messages.reduce((total, message) => total + message.content.length / 4, 0);

      return {
        content,
        tokenEstimate,
        costEstimateUsd: 0,
      };
    },
  };
}
