import type { AppConfig } from "../config";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "./types";
import { estimateAnthropicCost } from "./pricing";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20260318";
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
  readonly server_tool_use?: {
    readonly web_search_requests?: number;
  };
}

interface AnthropicResponse {
  readonly content?: readonly AnthropicContentBlock[];
  readonly usage?: AnthropicUsage;
}

interface AnthropicErrorResponse {
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
  };
  readonly request_id?: string;
}

function readAnthropicResponse(value: unknown): AnthropicResponse {
  return typeof value === "object" && value !== null ? (value as AnthropicResponse) : {};
}

function readAnthropicErrorResponse(value: unknown): AnthropicErrorResponse {
  return typeof value === "object" && value !== null ? (value as AnthropicErrorResponse) : {};
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
  return Math.ceil(messages.reduce((total, message) => total + message.content.length / 4, 0));
}

async function buildErrorMessage(response: Response): Promise<string> {
  const status = String(response.status);
  const body = await response.text();

  if (body.trim() === "") {
    return `Anthropic request failed with status ${status}`;
  }

  try {
    const payload = readAnthropicErrorResponse(JSON.parse(body));
    const details = [
      payload.error?.message,
      payload.error?.type !== undefined ? `type=${payload.error.type}` : undefined,
      payload.request_id !== undefined ? `request_id=${payload.request_id}` : undefined,
    ].filter((detail) => detail !== undefined);

    if (details.length > 0) {
      return `Anthropic request failed with status ${status}: ${details.join("; ")}`;
    }
  } catch {
    // Fall through to the raw body for non-JSON provider errors.
  }

  return `Anthropic request failed with status ${status}: ${body}`;
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
          ...(request.webSearch === true
            ? { tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: "web_search" }] }
            : {}),
          ...(request.params?.reasoningEffort !== undefined
            ? { output_config: { effort: request.params.reasoningEffort } }
            : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(await buildErrorMessage(response));
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
      const cost = estimateAnthropicCost(
        request.model,
        payload.usage?.input_tokens,
        payload.usage?.output_tokens,
        payload.usage?.server_tool_use?.web_search_requests,
      );

      return {
        content,
        tokenEstimate,
        ...cost,
      };
    },
  };
}
